import { BadRequestException, Injectable } from "@nestjs/common";
import type { McpContext } from "@nestjs/mcp";
import { MACHINE_MODELS, STARTING_SHAPES } from "@decent-sync/protocol";
import * as z from "zod";
import { CHANGE, READ } from "../connected-apps/oauth.js";
import { type DraftSummary, type DraftView, DraftsService, MAX_DRAFT_STEPS } from "../library/drafts.service.js";
import { DraftFollowingService, type DraftTrying, FOLLOWING_ENDS_LOADED_RECIPE, MAX_TRIAL_SHOTS } from "../library/draft-following.service.js";
import { type PublishedView, PublishingService, readPublishAsk } from "../library/publishing.service.js";
import { readProfileId } from "../library/profiles.service.js";
import { type Budget, BudgetedTool } from "./budget.js";
import { askedCurves } from "./curves.js";
import { editorOf } from "./library-changes.tools.js";
import { profileShape, source } from "./library.tools.js";
import { RUN_CURVES, simulateBudget, simulateInput, simulateOutput, simulationOf } from "./simulation.tools.js";
import { callerOf } from "./token-verifier.js";

// Drafts through an assistant (ADR-0026, ADR-0032, ticket #579), as the
// REST API has them (`DraftsService`): listed, read, started from a Library
// Profile, a starting shape or a profile, saved, simulated and discarded,
// by an Admin or Staff, as anyone who may change the Library may. A Viewer
// sees none. Publishing one, and returning a Profile to an earlier version
// (#580), are here too, Staff choosing only their own Locations; and so is
// trying one on a Machine (#581): a Draft's read says whether a Machine
// follows it and lists its Trial Shots, and following starts and stops here.

const id = z.string();
const CHANGES = { readOnlyHint: false, destructiveHint: false, openWorldHint: false } as const;

/** What a Draft is, for the tools' descriptions. */
const DRAFTS =
  "A Draft is a profile being written or changed here, held by Decent Sync alone and on no tablet until publish_draft makes it a Profile. Admins and Staff may read, change, publish and discard any Draft, the later save winning, Staff publishing only to the Locations they work at; a Viewer sees none. Its times are UTC.";

const newerShape = z.object({ id, title: z.string().nullable(), savedAt: z.string().describe("When the Library gained it.") });

const checkShape = z.object({ code: z.string(), step: z.number().nullable(), path: z.string().optional(), message: z.string() });

const draftSummary = z.object({
  id,
  title: z.string().describe("Its profile's title; empty for none yet."),
  startedFrom: z
    .object({ id, title: z.string().nullable(), bundled: z.boolean().nullable() })
    .nullable()
    .describe("The Library Profile it was started from, to change it (publishesAs version) or as a copy (separate); title and bundled null where the Library no longer has it. Null for one started from a starting shape or a profile."),
  shape: z.object({ key: z.string(), title: z.string() }).nullable().describe("The starting shape it was started from; null for one started otherwise."),
  publishesAs: z.enum(["version", "separate"]).describe("What publishing it makes: a new Profile Version of startedFrom (version), or a Profile of its own (separate)."),
  savedBy: source.describe("Who saved it last."),
  savedAt: z.string().describe("When it was saved last."),
  saves: z.number().describe("How many times it has been saved, its start the first: edit_draft names the count its change started from."),
  createdAt: z.string(),
});

const draftItem = draftSummary.extend({
  profile: profileShape,
  profileId: z.string().describe("The id Decaid would give its profile, which publishing it would make a Profile under."),
  models: z.array(z.enum(MACHINE_MODELS)).describe("The models the account has Machines of: its values are held to the widest of their ranges."),
  machineModel: z.enum(MACHINE_MODELS).describe("The model simulate_draft simulates it as where none is asked for."),
  checks: z
    .object({ blocking: z.array(checkShape), advice: z.array(checkShape) })
    .describe(
      "Its checks, but those of a simulated run, which simulate_draft adds: blocking, what would stop it being published, as no title, no steps, a step with no name, a value out of range, more steps than a machine takes or steps a Library Profile has (sameSteps); and advice, what the machine accepts but may not be meant, each naming its step by index, or null for the whole profile.",
    ),
  newer: z
    .array(newerShape)
    .describe("For a new version, the versions of startedFrom the Library gained since the Draft began, from a tablet or another Draft, the latest first: publishing it then forks the chain beside them, so tell the person and offer to compare first. Empty otherwise."),
});

const machineRef = z.object({ id, name: z.string() });
const locationRef = z.object({ id, name: z.string() });

const followingShape = z
  .object({
    machine: machineRef.extend({ location: locationRef.nullable() }),
    startedAt: z.string(),
    state: z
      .enum(["current", "waiting", "ended"])
      .describe("current: the Machine has the Draft's steps as saved; waiting: it is still to be written them, as while it is off or pulling a Shot; ended: following ended, and it is written nothing more until follow_draft is called again."),
    since: z.string().nullable().describe("When the Machine was written the steps of the Draft it has; null until it is written any."),
    waitingFor: z.string().nullable().describe("Why it is still to be written, where known, as its tablet's refusal; null otherwise."),
    ended: z
      .object({ at: z.string(), why: z.enum(["workflow", "stopped", "location"]) })
      .nullable()
      .describe("For one that ended: when, and why. workflow: the Machine's Workflow came to hold another profile, whoever changed it, a barista, a Recipe or Streamline's wake profile; stopped: someone stopped it, or had another Machine follow the Draft; location: its Location stopped trying Drafts, or the Machine left it or became Capture-only."),
    has: z.string().nullable().describe("The title of the profile the Machine's Workflow holds now."),
    titleOnTablet: z.string().describe("The title the Draft is on the tablet under."),
  })
  .nullable()
  .describe("The Machine the Draft is followed on, or was last; null where it never was.");

const tryingShape = z.object({
  following: followingShape,
  machines: z
    .array(
      machineRef.extend({
        location: locationRef,
        needsPluginUpdate: z.boolean().describe("Its plugin is from before a Machine could follow a Draft: it needs updating first."),
        canFollow: z.boolean().describe("Whether follow_draft can name it now: false too for one whose tablet has not connected since the server was upgraded."),
        follows: z.object({ id, title: z.string() }).nullable().describe("Another Draft it follows now, which stop_following_draft is to stop first."),
      }),
    )
    .describe("The Machines the Draft can be followed on: those at a Location an Admin turned trying Drafts on for (edit_location)."),
  trialShots: z
    .array(
      z.object({
        id: z.string().describe("The Shot, as get_shot reads it and simulate_draft's shotId takes it."),
        pulledAt: z.string().nullable(),
        machine: machineRef.nullable(),
        duration: z.number().nullable().describe("In seconds, without its Preheat."),
        dose: z.number().nullable(),
        yield: z.number().nullable(),
        steps: z.enum(["current", "earlier"]).describe("Whether it ran the Draft's steps as saved now, or earlier ones."),
        trialId: z.string().describe("The steps it ran, which get_draft reads given as trialId."),
      }),
    )
    .describe(`Its Trial Shots, the latest first, at most ${MAX_TRIAL_SHOTS}: the Shots pulled with its steps on a Machine following it, whatever the brew temperature or yield set on the tablet.`),
});

const TRYING =
  "A Machine at a Location that tries Drafts can follow a Draft: its tablet is written the Draft's profile as its Workflow's, now and on each save, held while a Shot runs, under the Draft's title with (Draft) after it and never as one of the tablet's Profiles. A Shot pulled on it with those steps is a Trial Shot.";

/** A Draft's profile, its steps, title, author and notes among it, given as it is (ADR-0028): rounded or cut, it would be another profile, which edit_draft, given it back, would refuse. */
const DRAFT_WHOLE = ["/draft/profile/title", "/draft/profile/author", "/draft/profile/notes", "/draft/profile/version", "/draft/profile/beverage_type", "/draft/profile/steps", "/draft/profile/tank_temperature", "/draft/profile/target_weight", "/draft/profile/target_volume", "/draft/profile/target_volume_count_start"];
const draftBudget: Budget = { whole: DRAFT_WHOLE };

const listOutput = z.object({ drafts: z.array(draftSummary).describe("Every Draft, the one saved last first.") });
const draftOutput = z.object({ draft: draftItem });
const triedDraftOutput = z.object({
  draft: draftItem.extend(tryingShape.shape),
  trial: z
    .object({ id, machine: machineRef, writtenAt: z.string(), profile: profileShape })
    .optional()
    .describe("For a trialId given: the profile the Draft was written to the Machine with, which that Trial Shot ran, to compare with the Draft's now or to give create_draft."),
});
const tryingOutput = z.object({ trying: tryingShape });
const heldShape = z.object({ step: z.number().nullable(), path: z.string(), from: z.number(), to: z.number() });

const shapeKeys = STARTING_SHAPES.map((shape) => shape.key) as [string, ...string[]];

const createInput = z.object({
  profileId: id.optional().describe("A Library Profile to start it from, with as."),
  as: z
    .enum(["version", "separate"])
    .optional()
    .describe("With profileId: version, to change that Profile, publishing as a new version of it, which one of Decaid's bundled Profiles refuses; or separate, a copy titled with \" copy\" after its title."),
  shape: z
    .enum(shapeKeys)
    .optional()
    .describe(`A starting shape to start it from, as a separate Profile: ${STARTING_SHAPES.map((shape) => `${shape.key} (${shape.title}: ${shape.description})`).join("; ")}`),
  profile: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("A profile to start it from, as a separate Profile: Decaid's profile JSON, a bare profile or a whole record holding it under profile, as an imported file is. Its values are held to the ranges, and held lists what was."),
});

const editInput = z.object({
  id: id.describe("The Draft."),
  saves: z.number().int().min(1).describe("The count of saves the change started from: the Draft's saves as last read. A save is taken whatever it names, and between says whether someone saved it meanwhile."),
  profile: profileShape.optional().describe(`Its whole profile as it should be, every field and step, up to ${MAX_DRAFT_STEPS} steps; left as it is where not given. Each value must be in the ranges of a model the account has Machines of.`),
  publishesAs: z.enum(["version", "separate"]).optional().describe("What publishing it makes; version only for a Draft started from a Library Profile."),
});

const editOutput = draftOutput.extend({
  between: z
    .object({ saves: z.number(), savedBy: source, savedAt: z.string() })
    .nullable()
    .describe("Saves made between the count given and this one: how many, and the latest of them, whose change this save replaced; null where none did."),
});

const simulateDraftInput = simulateInput.omit({ profileId: true }).extend({ id: id.describe("The Draft to simulate.") });
const simulateDraftOutput = simulateOutput.omit({ profile: true }).extend({ draft: z.object({ id, title: z.string() }) });

const placeShape = z.object({ id, name: z.string() });
const recipeRefShape = z.object({ id, name: z.string().nullable(), location: placeShape });

const whereInput = {
  locations: z.array(id).min(1).describe("The ids of the Locations to show it at, at least one; Staff only those they work at. For a new version, those showing the Profile it replaces are the usual choice."),
  recipes: z
    .array(id)
    .optional()
    .describe("The ids of the Recipes naming the Profile it replaces to move to it, each at one of the Locations; none where not given. get_profile_versions lists them with the Machines that have each loaded, which take the change: ask the person which to move."),
};

const publishInput = z.object({
  id: id.describe("The Draft."),
  saves: z.number().int().min(1).describe("The Draft's saves as last read: refused where someone saved it since, as the person would publish what they haven't seen."),
  ...whereInput,
});

const returnInput = z.object({
  profileId: id.describe("The version to return to: one of from's Profile Versions (get_profile_versions)."),
  from: id.describe("The later version it takes the place of."),
  ...whereInput,
});

const publishedOutput = z.object({
  published: z.object({
    profile: z.object({ id, title: z.string().nullable() }).describe("The Profile now shown at the Locations: the one published, or the version returned to."),
    replaced: z.object({ id, title: z.string().nullable() }).nullable().describe("The Profile it took the place of; null for a separate Profile."),
    shownAt: z.array(placeShape),
    hiddenAt: z.array(placeShape).describe("Where the Profile it replaced was hidden."),
    keptAt: z.array(z.object({ location: placeShape, recipes: z.array(recipeRefShape) })).describe("Locations chosen that still show the Profile it replaced, as Recipes there not moved name it."),
    moved: z.array(recipeRefShape).describe("The Recipes moved to it, each an edit in its history, reaching the Machines that have it loaded."),
    forked: z.array(newerShape).describe("Newer versions of the Profile the Draft started from, beside which it now forks the chain."),
  }),
});

@Injectable()
export class DraftsTools {
  constructor(
    private readonly drafts: DraftsService,
    private readonly publishing: PublishingService,
    private readonly followings: DraftFollowingService,
  ) {}

  @BudgetedTool({
    name: "list_drafts",
    title: "List Drafts",
    description: `Lists every Draft, the one saved last first, each with what it will publish as and who saved it last. ${DRAFTS}`,
    outputSchema: listOutput,
    annotations: { readOnlyHint: true },
    scopes: [READ],
  })
  async listDrafts(_: unknown, context: McpContext): Promise<{ drafts: DraftSummary[] }> {
    return { drafts: await this.drafts.list(callerOf(context).scope) };
  }

  @BudgetedTool({
    name: "get_draft",
    title: "Read a Draft",
    description: `Reads a Draft: its whole profile, as Decaid reads one, what it will publish as, who saved it last, how many times it has been saved, its checks, whether a Machine follows it and has its steps, the Machines that can, and its Trial Shots. ${DRAFTS} ${TRYING}`,
    inputSchema: z.object({ id: id.describe("The Draft."), trialId: id.optional().describe("One of its Trial Shots' trialId, to read the steps that Shot ran as trial.") }),
    outputSchema: triedDraftOutput,
    annotations: { readOnlyHint: true },
    scopes: [READ],
    budget: { whole: [...DRAFT_WHOLE, "/trial/profile"] },
  })
  async getDraft({ id: draftId, trialId }: { id: string; trialId?: string }, context: McpContext): Promise<z.infer<typeof triedDraftOutput>> {
    const { scope } = callerOf(context);
    const draft = await this.drafts.get(draftId, scope);
    const trying = tryingOf(await this.followings.trying(draftId, scope));
    const trial = trialId === undefined ? undefined : await this.followings.trial(draftId, trialId, scope);
    return { draft: { ...draft, ...trying }, ...(trial ? { trial } : {}) } as z.infer<typeof triedDraftOutput>;
  }

  @BudgetedTool({
    name: "follow_draft",
    title: "Have a Machine follow a Draft",
    description: `Has a Machine follow a Draft, as its page in the management interface does: one of get_draft's machines that canFollow, which follows one Draft at a time. ${FOLLOWING_ENDS_LOADED_RECIPE}: tell the person so, and ask before calling it. Following ends by itself once the Machine's Workflow holds another profile, whoever changed it, and when the Draft is published or discarded; Decent Sync then writes the Machine nothing until this is called again, which replaces what it has loaded. Staff choose only Machines at their Locations. Returns how the Draft is tried, as get_draft does. ${TRYING}`,
    inputSchema: z.object({ id: id.describe("The Draft."), machineId: id.describe("The Machine, as get_draft's machines gives it.") }),
    outputSchema: tryingOutput,
    annotations: { ...CHANGES, idempotentHint: true },
    scopes: [READ, CHANGE],
  })
  async followDraft({ id: draftId, machineId }: { id: string; machineId: string }, context: McpContext): Promise<z.infer<typeof tryingOutput>> {
    return { trying: tryingOf(await this.followings.start(draftId, machineId, callerOf(context).scope)) };
  }

  @BudgetedTool({
    name: "stop_following_draft",
    title: "Stop a Machine following a Draft",
    description: `Stops the Machine following a Draft: it keeps what its Workflow holds, the Draft's steps as last written, and is written nothing more. Its Trial Shots stay the Draft's. Returns how the Draft is tried, as get_draft does. ${TRYING}`,
    inputSchema: z.object({ id: id.describe("The Draft.") }),
    outputSchema: tryingOutput,
    annotations: { ...CHANGES, idempotentHint: false },
    scopes: [READ, CHANGE],
  })
  async stopFollowingDraft({ id: draftId }: { id: string }, context: McpContext): Promise<z.infer<typeof tryingOutput>> {
    return { trying: tryingOf(await this.followings.stop(draftId, callerOf(context).scope)) };
  }

  @BudgetedTool({
    name: "create_draft",
    title: "Start a Draft",
    description: `Starts a Draft, from one of: a Library Profile (profileId, with as), a starting shape (shape) or a profile (profile), such as one written from a person's description; then edit_draft changes it and simulate_draft simulates it. Returns it as get_draft does, with held: the values of a profile given that were held to the ranges, each from what to what. ${DRAFTS}`,
    inputSchema: createInput,
    outputSchema: draftOutput.extend({ held: z.array(heldShape) }),
    annotations: CHANGES,
    scopes: [READ, CHANGE],
    budget: draftBudget,
  })
  async createDraft(input: z.infer<typeof createInput>, context: McpContext): Promise<{ draft: DraftView; held: unknown[] }> {
    const given = [input.profileId, input.shape, input.profile].filter((value) => value !== undefined).length;
    if (given !== 1) throw new BadRequestException("Start a Draft from one of profileId, with as, shape or profile");
    const start =
      input.profileId !== undefined
        ? { kind: "profile" as const, profileId: readProfileId(input.profileId), publishesAs: input.as ?? missingAs() }
        : input.shape !== undefined
          ? { kind: "shape" as const, shape: input.shape }
          : { kind: "file" as const, content: input.profile };
    return this.drafts.create(start, editorOf(context), callerOf(context).scope);
  }

  @BudgetedTool({
    name: "edit_draft",
    title: "Change a Draft",
    description: `Saves a change to a Draft: its whole profile, as get_draft gave it with the change made, and what it will publish as. Returns it as get_draft does. ${DRAFTS}`,
    inputSchema: editInput,
    outputSchema: editOutput,
    annotations: CHANGES,
    scopes: [READ, CHANGE],
    budget: draftBudget,
  })
  async editDraft({ id: draftId, saves, profile, publishesAs }: z.infer<typeof editInput>, context: McpContext): Promise<z.infer<typeof editOutput>> {
    if (profile === undefined && publishesAs === undefined) throw new BadRequestException("Give profile, publishesAs or both to change");
    return (await this.drafts.save(draftId, { profile, publishesAs, saves }, editorOf(context), callerOf(context).scope)) as z.infer<typeof editOutput>;
  }

  @BudgetedTool({
    name: "simulate_draft",
    title: "Simulate a Draft",
    description: `Simulates a Draft as simulate_profile simulates a Library Profile, taking the same puck, dose, stop-at weight, model and curves, and answering the same, with the Draft named in place of the Profile: on the model of the Profile it was started from, where none is asked for, else a DE1, or a Bengle where every Machine of the account is one. Its checks are get_draft's with those of the run. ${DRAFTS}`,
    inputSchema: simulateDraftInput,
    outputSchema: simulateDraftOutput,
    annotations: { readOnlyHint: true },
    scopes: [READ],
    budget: simulateBudget,
  })
  async simulateDraft(input: z.input<typeof simulateDraftInput>, context: McpContext): Promise<z.infer<typeof simulateDraftOutput>> {
    const { curves = true, id: draftId, ...ask } = input;
    if (ask.shotId !== undefined && ask.grind !== undefined) throw new BadRequestException("Choose a Shot's puck or the standard puck's grind, not both");
    const { draft, ...simulation } = await this.drafts.simulate(
      draftId,
      { shotId: ask.shotId ?? null, grind: ask.grind ?? 0, dose: ask.dose ?? null, stopAt: ask.stopAt ?? null, model: ask.model ?? null },
      callerOf(context).scope,
    );
    const { profile: _, ...answer } = simulationOf({ profile: { id: draft.id, title: draft.title }, ...simulation }, askedCurves(RUN_CURVES, curves));
    return { draft, ...answer };
  }

  @BudgetedTool({
    name: "publish_draft",
    title: "Publish a Draft",
    description: `Publishes a Draft, making it a Profile under the id Decaid computes, as its page in the management interface does: shown at the Locations given, where the Library writes it to the tablets as any Profile, whether or not they are online now, and the Draft discarded. As a new version (publishesAs version), the Recipes given move to it, and the Profile it started from is hidden at each Location given but where a Recipe not moved still names it; as a separate Profile, it moves no Recipes and the one it started from is untouched. Refused for what get_draft's blocking checks name, for a title a Profile shown at one of the Locations has (but the versions it replaces), and at a Location with a Machine that can't run it. Tell the person what it changes at each Location, the Recipes and the Machines that have them loaded, and ask before calling it. ${DRAFTS}`,
    inputSchema: publishInput,
    outputSchema: publishedOutput,
    annotations: { ...CHANGES, idempotentHint: false },
    scopes: [READ, CHANGE],
  })
  async publishDraft({ id: draftId, saves, locations, recipes = [] }: z.infer<typeof publishInput>, context: McpContext): Promise<{ published: PublishedView }> {
    return { published: await this.publishing.publish(draftId, { ...readWhere(locations, recipes), saves }, editorOf(context), callerOf(context).scope) };
  }

  @BudgetedTool({
    name: "return_to_profile_version",
    title: "Return to an earlier Profile Version",
    description: `Returns a Profile to an earlier version of it, as its page in the management interface does, creating nothing: the version returned to is shown at the Locations given, the Recipes given move to it from the later one (from), and the later one is hidden at each Location given but where a Recipe not moved still names it. Refused for a Profile not among from's versions, one Archived, and at a Location with a Machine that can't run it. Staff choose only the Locations they work at. Ask the person before calling it.`,
    inputSchema: returnInput,
    outputSchema: publishedOutput,
    annotations: { ...CHANGES, idempotentHint: false },
    scopes: [READ, CHANGE],
  })
  async returnToVersion({ profileId, from, locations, recipes = [] }: z.infer<typeof returnInput>, context: McpContext): Promise<{ published: PublishedView }> {
    return { published: await this.publishing.returnTo(readProfileId(profileId), readProfileId(from), readWhere(locations, recipes), editorOf(context), callerOf(context).scope) };
  }

  @BudgetedTool({
    name: "discard_draft",
    title: "Discard a Draft",
    description: `Discards a Draft, which leaves nothing of it behind: ask the person first. ${DRAFTS}`,
    inputSchema: z.object({ id: id.describe("The Draft.") }),
    outputSchema: z.object({ discarded: z.literal(true) }),
    annotations: { ...CHANGES, destructiveHint: true, idempotentHint: false },
    scopes: [READ, CHANGE],
  })
  async discardDraft({ id: draftId }: { id: string }, context: McpContext): Promise<{ discarded: true }> {
    await this.drafts.discard(draftId, callerOf(context).scope);
    return { discarded: true };
  }
}

/** How a Draft is tried, its Trial Shots each in a few numbers. */
function tryingOf(trying: DraftTrying): z.infer<typeof tryingShape> {
  return {
    following: trying.following,
    machines: trying.machines,
    trialShots: trying.trialShots.map(({ shot, steps, trialId }) => ({
      id: shot.id,
      pulledAt: shot.pulledAt?.toISOString() ?? null,
      machine: shot.machine,
      duration: shot.duration,
      dose: shot.actualDose ?? shot.targetDose,
      yield: shot.actualYield ?? shot.targetYield,
      steps,
      trialId,
    })),
  };
}

/** Where to publish or return, as the REST API reads it (`readPublishAsk`). */
function readWhere(locations: string[], recipes: string[]): { locations: string[]; recipes: string[] } {
  return readPublishAsk({ locations, recipes });
}

function missingAs(): never {
  throw new BadRequestException('Give as with profileId: "version" to change the Profile, or "separate" for a copy of it');
}
