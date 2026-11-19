import { ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { DRAFT_KIND, type Profile, followedDraftTitle, readProfile } from "@decent-sync/protocol";
import { type Scope, includesLocation } from "../accounts/scope.js";
import { Prisma } from "../generated/prisma/client.js";
import { readMachineId } from "../machines/input.js";
import { Notifications, notify } from "../notifications.js";
import { PrismaService } from "../prisma.service.js";
import { ShotsService } from "../shots/shots.service.js";
import { type FollowingEnded, canFollow, endFollowingsSql, endStrandedFollowings, followedProfile, sameJson, sendable, trialShotsSql } from "./draft-following.js";
import { VIEWER_SEES_NO_DRAFTS, readDraftId } from "./drafts.service.js";
import { writeKey } from "./holdings.js";

// Trying a Draft on a Machine (ADR-0032, ticket #581), as the REST API and
// the MCP endpoint read and change it: which Machines can follow a Draft,
// turning following on and off, whether the Machine has the Draft's steps,
// and the Draft's Trial Shots. What the tablet is due, and how following
// ends itself, are in draft-following.ts.

/** A Machine a Draft can be followed on: one taking part at a Location that tries Drafts. */
export interface FollowableMachine {
  id: string;
  name: string;
  location: { id: string; name: string };
  /** Whether its plugin is from before a Machine could follow a Draft, as its latest connection's said: following it waits for its plugin to be updated. */
  needsPluginUpdate: boolean;
  /** Whether it can be followed on now: its plugin has connected since the server could ask it, and can. */
  canFollow: boolean;
  /** The other Draft it follows now, which is to stop first; null for none, and for this Draft. */
  follows: { id: string; title: string } | null;
}

/** Whether, and how, a Draft is followed on a Machine. */
export interface FollowingView {
  machine: { id: string; name: string; location: { id: string; name: string } | null };
  /** When following was last turned on. */
  startedAt: string;
  /**
   * `current`: the Machine has the Draft's steps as saved, since `since`;
   * `waiting`: it is still to be written them, as it is off, pulling a Shot
   * or refusing them (`waitingFor`); `ended`: following ended (`ended`), and
   * the server writes it nothing more until someone follows again.
   */
  state: "current" | "waiting" | "ended";
  /** When the Machine was written the steps it has of the Draft, by PostgreSQL's clock; null until it is written any. */
  since: string | null;
  /** Why the Machine is still to be written, where the server knows: the Draft can't be a Workflow's profile as it is, or the tablet refused it. Null otherwise. */
  waitingFor: string | null;
  /**
   * For one that ended: when, and why. `workflow`: the Machine's Workflow
   * came to hold another profile, whatever changed it; `stopped`: someone
   * turned it off, or had another Machine follow the Draft; `location`: its
   * Location stopped trying Drafts, or the Machine left it.
   */
  ended: { at: string; why: FollowingEnded } | null;
  /** The title of the profile the Machine's Workflow holds now, as its tablet last reported it; null where it reported none. */
  has: string | null;
  /** The title the Draft is on the tablet under. */
  titleOnTablet: string;
}

/** A Trial Shot of a Draft: the Shot, as the Shots list shows one, and the steps it ran. */
export interface TrialShotView {
  shot: Awaited<ReturnType<ShotsService["listed"]>>[number];
  /** The profile the Draft was written to the Machine with that the Shot ran (`trial`). */
  trialId: string;
  /** Whether those are the Draft's steps as saved now, or earlier ones. */
  steps: "current" | "earlier";
}

/** A Draft as it is tried: whether it is followed, where it can be, and its Trial Shots. */
export interface DraftTrying {
  following: FollowingView | null;
  machines: FollowableMachine[];
  /** Its Trial Shots, the latest first, at most MAX_TRIAL_SHOTS. */
  trialShots: TrialShotView[];
}

/** A profile a Draft was written to a following Machine with, which a Trial Shot ran. */
export interface TrialView {
  id: string;
  machine: { id: string; name: string };
  /** When the Machine was written it, by PostgreSQL's clock. */
  writtenAt: string;
  /** The profile, under the Draft's own title as it was then. */
  profile: Profile;
}

/** The most Trial Shots a Draft's read lists, the latest. */
export const MAX_TRIAL_SHOTS = 50;

/** What following a Draft tells the person first (story 70). */
export const FOLLOWING_ENDS_LOADED_RECIPE = "Following ends the Machine's Loaded Recipe; its dose, yield, Bean Batch, Grinder and Basket stay as they are";

@Injectable()
export class DraftFollowingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly shots: ShotsService,
    notifications: Notifications,
  ) {
    // A Machine that moved, left its Location or became capture-only follows no Draft from then on; after listening
    // anew, when a move may have been missed, every following is looked at.
    notifications.subscribe("machine_locations", (machineId) => {
      void endStrandedFollowings(this.prisma, machineId ?? undefined).catch(() => {});
    });
  }

  /** How the Draft is tried. 404 for no such Draft; 403 for a Viewer. */
  async trying(id: string, scope: Scope): Promise<DraftTrying> {
    refuseViewer(scope);
    const draftId = readDraftId(id);
    return this.prisma.$transaction(
      async (tx) => {
        const draft = await tx.draft.findUnique({ where: { id: draftId }, select: { id: true, profile: true } });
        if (!draft) throw draftNotFound();
        const [following, machines, trials, profiles] = await Promise.all([
          this.following(tx, draft),
          this.machines(tx, draftId),
          tx.$queryRaw<{ id: string; trialId: string }[]>(trialShotsSql(draftId, MAX_TRIAL_SHOTS)),
          tx.$queryRaw<{ id: string; profile: unknown }[]>`SELECT id::text AS id, profile FROM draft_trials WHERE draft_id = ${draftId}::uuid`,
        ]);
        // A trial ran the current steps where the Draft as saved now, as a following Machine is written it, is the profile it was written, whatever its title.
        const now = followedProfile(draft.profile);
        const current = new Set(profiles.filter((trial) => now !== null && sameJson({ ...(trial.profile as object), title: "" }, { ...now, title: "" })).map((trial) => trial.id));
        return { following, machines, trials: trials.map((trial) => ({ ...trial, current: current.has(trial.trialId) })) };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    ).then(async ({ following, machines, trials }) => {
      const byId = new Map(trials.map((trial) => [trial.id, trial]));
      const shots = await this.shots.listed(trials.map((trial) => trial.id));
      return {
        following,
        machines,
        trialShots: shots.map((shot) => ({ shot, trialId: byId.get(shot.id)!.trialId, steps: byId.get(shot.id)!.current ? ("current" as const) : ("earlier" as const) })),
      };
    });
  }

  /** A profile the Draft was written to a Machine with. 404 for no such Draft or none such of it; 403 for a Viewer. */
  async trial(id: string, trial: string, scope: Scope): Promise<TrialView> {
    refuseViewer(scope);
    const draftId = readDraftId(id);
    const [row] = /^[0-9a-f-]{36}$/i.test(trial)
      ? await this.prisma.$queryRaw<{ id: string; machineId: string; machineName: string; writtenAt: Date; profile: unknown; title: string | null }[]>`
          SELECT t.id::text AS id, m.id::text AS "machineId", m.name AS "machineName", t.written_at AS "writtenAt", t.profile, d.profile ->> 'title' AS title
          FROM draft_trials t JOIN machines m ON m.id = t.machine_id JOIN drafts d ON d.id = t.draft_id
          WHERE t.draft_id = ${draftId}::uuid AND t.id::text = ${trial.toLowerCase()}`
      : [];
    const profile = row ? readProfile(row.profile).profile : null;
    if (!row || !profile) throw new NotFoundException("The Draft was tried with no such steps");
    // Under the Draft's own title, as the title a tablet shows it by is the tablet's alone.
    return { id: row.id, machine: { id: row.machineId, name: row.machineName }, writtenAt: row.writtenAt.toISOString(), profile: { ...profile, title: row.title ?? profile.title } };
  }

  /**
   * Has the Machine follow the Draft: its tablet is written the Draft's
   * profile as its Workflow's, now and on each save, which ends its Loaded
   * Recipe. Only a Machine taking part at a Location that tries Drafts can,
   * 409 otherwise, and only one whose plugin can, 409 for one needing its
   * plugin updated or not yet connected. A Machine follows one Draft at a
   * time, so one following another is refused, 409, naming it. A Draft
   * followed elsewhere moves to this Machine, the other left as it is.
   * Staff follow only on Machines at their Locations, 403. 404 for no such
   * Draft or Machine.
   */
  async start(id: string, machine: string, scope: Scope): Promise<DraftTrying> {
    refuseViewer(scope);
    const draftId = readDraftId(id);
    const machineId = readMachineId(machine).toLowerCase();
    await this.prisma.$transaction(async (tx) => {
        // The Draft's row first, as its saves and its publishing take it, then the Machine's, then the following's.
        const [draft] = await tx.$queryRaw<{ profile: unknown }[]>`SELECT profile FROM drafts WHERE id = ${draftId}::uuid FOR UPDATE`;
        if (!draft) throw draftNotFound();
        const [found] = await tx.$queryRaw<
          { name: string; sharing: boolean; wireRevision: number | null; pluginVersion: string | null; locationId: string | null; locationName: string | null; triesDrafts: boolean | null }[]
        >`
          SELECT m.name, m.sharing, m.wire_revision AS "wireRevision", m.plugin_version AS "pluginVersion",
            l.id::text AS "locationId", l.name AS "locationName", l.tries_drafts AS "triesDrafts"
          FROM machines m
          LEFT JOIN LATERAL (SELECT location_id FROM location_assignments WHERE machine_id = m.id ORDER BY effective_from DESC LIMIT 1) AS latest ON true
          LEFT JOIN locations l ON l.id = latest.location_id
          WHERE m.id = ${machineId}::uuid
          -- Held, so two Drafts beginning to follow it are decided one after the other.
          FOR NO KEY UPDATE OF m`;
        if (!found) throw new NotFoundException("No such Machine");
        if (found.locationId === null || !found.sharing) throw new ConflictException(`${found.name} is a Capture-only Machine, which follows no Draft`);
        if (!includesLocation(scope, found.locationId)) throw new ForbiddenException(`Only an Admin or Staff working at ${found.locationName} can have its Machines follow a Draft`);
        if (!found.triesDrafts) throw new ConflictException(`Drafts are not tried at ${found.locationName}: an Admin turns that on for a Location`);
        if (!canFollow(found.wireRevision)) {
          throw new ConflictException(
            found.wireRevision === null
              ? `${found.name}'s tablet has not connected since the server could have it follow a Draft`
              : `${found.name} needs its plugin updated before it can follow a Draft`,
          );
        }
        const profile = followedProfile(draft.profile);
        if (profile === null || !sendable(profile)) throw new ConflictException("The Draft needs steps, and no more than a machine takes, before a Machine can follow it");
        const [other] = await tx.$queryRaw<{ title: string | null }[]>`
          SELECT d.profile ->> 'title' AS title FROM draft_followings f JOIN drafts d ON d.id = f.draft_id
          WHERE f.machine_id = ${machineId}::uuid AND f.ended_at IS NULL AND f.draft_id <> ${draftId}::uuid`;
        if (other) throw new ConflictException(`${found.name} is following another Draft, "${other.title?.trim() || "untitled"}": a Machine follows one Draft at a time, so stop that first`);
        // A following going on elsewhere ends there, and Shots pulled there from now are none of the Draft's.
        await tx.$executeRaw(
          endFollowingsSql(Prisma.sql`
            UPDATE draft_followings SET ended_at = statement_timestamp(), ended_why = 'stopped'
            WHERE draft_id = ${draftId}::uuid AND ended_at IS NULL AND machine_id <> ${machineId}::uuid RETURNING draft_id`),
        );
        await tx.$executeRaw`
          INSERT INTO draft_followings (draft_id, machine_id) VALUES (${draftId}::uuid, ${machineId}::uuid)
          ON CONFLICT (draft_id) DO UPDATE SET machine_id = EXCLUDED.machine_id, started_at = statement_timestamp(), trial_id = NULL, ended_at = NULL, ended_why = NULL`;
        // Its tablet's writer, on whichever instance, looks for what it is due.
        await notify(tx, "library_changes", found.locationId);
      });
    return this.trying(draftId, scope);
  }

  /** Stops the Draft's following: the Machine keeps what its Workflow holds, and is written nothing more. 409 where it is not being followed; 404 for no such Draft; 403 for a Viewer. */
  async stop(id: string, scope: Scope): Promise<DraftTrying> {
    refuseViewer(scope);
    const draftId = readDraftId(id);
    await this.prisma.$transaction(async (tx) => {
      const drafts = await tx.$queryRaw<unknown[]>`SELECT 1 FROM drafts WHERE id = ${draftId}::uuid FOR UPDATE`;
      if (drafts.length === 0) throw draftNotFound();
      const going = await tx.$queryRaw<unknown[]>`SELECT 1 FROM draft_followings WHERE draft_id = ${draftId}::uuid AND ended_at IS NULL`;
      if (going.length === 0) throw new ConflictException("No Machine is following the Draft");
      await tx.$executeRaw(
        endFollowingsSql(Prisma.sql`
          UPDATE draft_followings SET ended_at = statement_timestamp(), ended_why = 'stopped' WHERE draft_id = ${draftId}::uuid AND ended_at IS NULL RETURNING draft_id`),
      );
    });
    return this.trying(draftId, scope);
  }

  private async following(tx: Prisma.TransactionClient, draft: { id: string; profile: unknown }): Promise<FollowingView | null> {
    const [row] = await tx.$queryRaw<
      {
        machineId: string;
        machineName: string;
        locationId: string | null;
        locationName: string | null;
        startedAt: Date;
        endedAt: Date | null;
        endedWhy: string | null;
        written: unknown;
        writtenAt: Date | null;
        has: string | null;
        refusal: string | null;
      }[]
    >`
      SELECT m.id::text AS "machineId", m.name AS "machineName", l.id::text AS "locationId", l.name AS "locationName",
        f.started_at AS "startedAt", f.ended_at AS "endedAt", f.ended_why AS "endedWhy", t.profile AS written, t.written_at AS "writtenAt",
        (SELECT w.workflow -> 'profile' ->> 'title' FROM workflow_events w WHERE w.machine_id = m.id ORDER BY w.id DESC LIMIT 1) AS has,
        (SELECT r.error FROM tablet_refusals r WHERE r.tablet_id = m.connected_tablet_id AND r.change_key = ${writeKey(DRAFT_KIND, draft.id)}) AS refusal
      FROM draft_followings f
      JOIN machines m ON m.id = f.machine_id
      LEFT JOIN LATERAL (SELECT location_id FROM location_assignments WHERE machine_id = m.id ORDER BY effective_from DESC LIMIT 1) AS latest ON true
      LEFT JOIN locations l ON l.id = latest.location_id
      LEFT JOIN draft_trials t ON t.id = f.trial_id
      WHERE f.draft_id = ${draft.id}::uuid`;
    if (!row) return null;
    const profile = followedProfile(draft.profile);
    const current = row.endedAt === null && profile !== null && row.written !== null && sameJson(row.written, profile);
    const title = readProfile(draft.profile).profile?.title ?? "";
    return {
      machine: { id: row.machineId, name: row.machineName, location: row.locationId === null || row.locationName === null ? null : { id: row.locationId, name: row.locationName } },
      startedAt: row.startedAt.toISOString(),
      state: row.endedAt !== null ? "ended" : current ? "current" : "waiting",
      since: row.endedAt === null && row.writtenAt !== null ? row.writtenAt.toISOString() : null,
      waitingFor:
        row.endedAt !== null || current
          ? null
          : profile === null || !sendable(profile)
            ? "The Draft needs steps, and no more than a machine takes, before the Machine is written it"
            : row.refusal,
      ended: row.endedAt === null ? null : { at: row.endedAt.toISOString(), why: endedWhy(row.endedWhy) },
      has: row.has?.trim() || null,
      titleOnTablet: followedDraftTitle(title),
    };
  }

  /** The Machines taking part at a Location that tries Drafts, by Location and name. */
  private async machines(tx: Prisma.TransactionClient, draftId: string): Promise<FollowableMachine[]> {
    const rows = await tx.$queryRaw<{ id: string; name: string; locationId: string; locationName: string; wireRevision: number | null; followsId: string | null; followsTitle: string | null }[]>`
      SELECT m.id::text AS id, m.name, l.id::text AS "locationId", l.name AS "locationName", m.wire_revision AS "wireRevision",
        f.draft_id::text AS "followsId", d.profile ->> 'title' AS "followsTitle"
      FROM machines m
      JOIN LATERAL (SELECT location_id FROM location_assignments WHERE machine_id = m.id ORDER BY effective_from DESC LIMIT 1) AS latest ON true
      JOIN locations l ON l.id = latest.location_id AND l.tries_drafts
      LEFT JOIN draft_followings f ON f.machine_id = m.id AND f.ended_at IS NULL AND f.draft_id <> ${draftId}::uuid
      LEFT JOIN drafts d ON d.id = f.draft_id
      WHERE m.sharing
      ORDER BY l.name, m.name`;
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      location: { id: row.locationId, name: row.locationName },
      needsPluginUpdate: row.wireRevision !== null && !canFollow(row.wireRevision),
      canFollow: canFollow(row.wireRevision),
      follows: row.followsId === null ? null : { id: row.followsId, title: row.followsTitle?.trim() ?? "" },
    }));
  }
}

function endedWhy(why: string | null): FollowingEnded {
  return why === "stopped" || why === "location" ? why : "workflow";
}

function refuseViewer(scope: Scope): void {
  if (scope.kind === "nothing") throw new ForbiddenException(VIEWER_SEES_NO_DRAFTS);
}

function draftNotFound(): NotFoundException {
  return new NotFoundException("No such Draft");
}
