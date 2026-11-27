import { profileOf } from "@decent-sync/protocol";
import { type FormEvent, type ReactNode, useCallback, useEffect, useId, useMemo, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router";
import { useIsAdmin, useMayChange, useStaffLocationIds } from "@/auth";
import {
  ConfirmButton,
  IdentificationBadge,
  LastSeen,
  LastShot,
  bindingOf,
  isRealSerial,
  sameHardware,
  PendingMachineActions,
  StatusBadge,
  describeHardware,
  describeMachineState,
  formatTime,
  needsHardware,
  useLocations,
} from "@/components/machines";
import { TokenNotice } from "@/components/TokenNotice";
import { BatchCell, BatchInLine } from "@/components/batch-name";
import { Field, Fields } from "@/components/fields";
import { CardTitleWithInfo } from "@/components/info-tip";
import { LiveViewCard } from "@/components/live-view";
import { LoadedRecipeLink } from "@/components/loaded-recipes";
import { MachineActivityCard } from "@/components/machine-activity";
import { LibraryCard, PairedDevicesCard, SETTINGS, SettingsCard } from "@/components/machine-collections";
import { CaptureOnlyBadge, MachineSharingCard } from "@/components/machine-sharing";
import { MachineShotsCard } from "@/components/machine-shots";
import { MachineUseCard } from "@/components/machine-use";
import { SetAsideDeliveriesCard } from "@/components/set-aside-deliveries";
import { SettingsHistoryCard } from "@/components/settings-history";
import { SoftwareTab } from "@/components/tablet-software";
import { workflowFields } from "@/components/workflow";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  ApiError,
  api,
  type BatchLink,
  type BeanBatch,
  type Collection,
  type CollectionSummary,
  type IssuedToken,
  type Location,
  type LocationHistoryEntry,
  type Machine,
  type PairedDevices,
  type PendingMachine,
  type Tablet,
  type Takeover,
  type TakeoverConnection,
  type WorkflowEvent,
  type WorkflowSummaryEvent,
} from "@/lib/api";
import { grams } from "@/lib/remaining-weight";
import { useKeptScroll } from "@/lib/use-kept-scroll";
import { DETAILS_POLL_MS, usePolled, useReloadOn } from "@/lib/use-polled";
import { cn } from "@/lib/utils";
import { formatInZone, fromZonedInput, toZonedInput } from "@/lib/zoned-time";

/** The page's tabs, as its address names them, in the order it offers them: the first is open where the address names none. */
const TABS = [
  { tab: "now", label: "Now" },
  { tab: "activity", label: "Activity" },
  { tab: "settings", label: "Settings" },
  { tab: "software", label: "Software" },
  { tab: "setup", label: "Setup" },
] as const;
type Tab = (typeof TABS)[number]["tab"];

/**
 * The address's query for a tab: the one it has with `tab` naming the tab, or
 * not there for Now, so what else it keeps, as the period Now's Shots card
 * shows, is still chosen on coming back.
 */
function tabSearch(params: URLSearchParams, tab: Tab): string {
  const next = new URLSearchParams(params);
  if (tab === "now") next.delete("tab");
  else next.set("tab", tab);
  // Its text, not its `size`, which the oldest browsers the build targets don't have.
  const query = next.toString();
  return query ? `?${query}` : "";
}

/**
 * One Machine (#545). Above its tabs, whichever is open: its name and
 * whether it is online; a line with what it is doing, its last Shot and
 * where it is; links to its Shots and Steam Records; and what needs
 * attention: a refused connection, a takeover, a mismatch, hardware to enter
 * or confirm, and a new token. Then five tabs, the one open kept in the
 * address as `tab`, so a link opens on it:
 * - Now: its Live View, its Workflow with the Loaded Recipe it was loaded
 *   from, and how its Shots are landing by Recipe;
 * - Activity: how much it was used, and what happened on it over a day;
 * - Settings: its settings, with their edits, its paired devices and its
 *   Settings History;
 * - Software: its Tablet Software, Decaid, the plugins and the Skins, with
 *   the Software Actions an Admin makes on them and their log;
 * - Setup: its hardware and firmware, its Location, its sharing, the
 *   library its tablet reported, its token and deliveries set aside.
 * Staff see all of it, and can move it between the Locations they work at;
 * every other change is for Admins.
 *
 * The Machine itself, with its status, is loaded every few seconds, whatever
 * tab is open. A tab loads what it shows only while it is open, and less
 * often: the Live View's stream runs only while Now is. A change made on
 * the page loads again at once all it can change: the Machine, a mismatch's
 * Pending Machine and what the open tab shows of its tablet's reports.
 */
export function MachinePage() {
  const { id = "" } = useParams();
  // Keyed, so a token or error shown for one Machine never carries over to the next one opened.
  return <MachineDetails key={id} id={id} />;
}

function MachineDetails({ id }: { id: string }) {
  const isAdmin = useIsAdmin();
  const [params] = useSearchParams();
  const tab: Tab = TABS.find((each) => each.tab === params.get("tab"))?.tab ?? "now";
  // A tab opened while scrolled down keeps the page's scroll position while its content is shorter, as while it loads.
  const keepScroll = useKeptScroll();
  const [notFound, setNotFound] = useState(false);
  const path = `/machines/${encodeURIComponent(id)}`;
  // With when the page asked for it, by its own clock, which the Live View orders its frames against.
  const loadMachine = useCallback(async () => {
    const askedAt = Date.now();
    try {
      const { machine } = await api<{ machine: Machine }>("GET", path);
      setNotFound(false);
      return { machine, askedAt };
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) setNotFound(true);
      throw error;
    }
  }, [path]);
  const status = usePolled(loadMachine);
  // The Pending Machine holding a mismatch's hardware, loaded as soon as the Machine's status names one.
  const pendingId = status.data?.machine.mismatch?.pendingMachineId ?? null;
  // Each answer names the id it was for, so one for an id the status no longer names is never shown.
  const loadPending = useCallback(async (): Promise<{ id: string | null; pendingMachine: PendingMachine | null }> => {
    if (pendingId === null) return { id: null, pendingMachine: null };
    try {
      const path = `/pending-machines/${encodeURIComponent(pendingId)}`;
      return { id: pendingId, pendingMachine: (await api<{ pendingMachine: PendingMachine }>("GET", path)).pendingMachine };
    } catch (error) {
      // A machine entry took its hardware over meanwhile, which the Machine's status shows next.
      if (error instanceof ApiError && error.status === 404) return { id: pendingId, pendingMachine: null };
      throw error;
    }
  }, [pendingId]);
  const pending = usePolled(loadPending, DETAILS_POLL_MS);
  const { reload: reloadStatus } = status;
  const { reload: reloadPending } = pending;
  // Counts the changes made on the page, so the open tab loads again what it shows of the tablet's reports as each is made.
  const [changed, setChanged] = useState(0);
  const reload = useCallback(async () => {
    setChanged((count) => count + 1);
    await Promise.all([reloadStatus(), reloadPending()]);
  }, [reloadStatus, reloadPending]);
  const error = status.error ?? pending.error;
  const [issued, setIssued] = useState<IssuedToken>();

  function created(token: IssuedToken) {
    setIssued(token);
    void reload();
  }

  if (notFound) {
    return (
      <section className="grid gap-4">
        <BackLink />
        <p role="alert">There is no such Machine. It may have been removed.</p>
      </section>
    );
  }

  const machine = status.data?.machine;
  // Undefined while the Pending Machine the status names is loading.
  const pendingMachine = pendingId === null ? null : pending.data?.id === pendingId ? pending.data.pendingMachine : undefined;
  return (
    <section className="grid grid-cols-1 gap-6">
      <div className="grid gap-2.5">
        <BackLink />
        {machine && <MachineHeading machine={machine} />}
      </div>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {/* Keyed, so a new token never inherits the last one's "Copied". */}
      {issued && <TokenNotice key={issued.token} issued={issued} onDone={() => setIssued(undefined)} />}
      {machine && (
        <>
          {machine.lastRefusal && (
            <Alert variant="destructive">
              <AlertTitle>A connection was refused at {formatTime(machine.lastRefusal.at)}</AlertTitle>
              <AlertDescription>{machine.lastRefusal.reason}</AlertDescription>
            </Alert>
          )}
          {machine.takeover && <TakeoverAlert takeover={machine.takeover} />}

          {machine.mismatch && (
            <Mismatch machine={machine} pending={pendingMachine} isAdmin={isAdmin} onCreated={created} onDismissed={reload} />
          )}
          {isAdmin &&
            needsHardware(machine) &&
            (machine.model === null ? (
              <EnterHardware machine={machine} onSaved={reload} />
            ) : (
              <ConfirmHardware machine={machine} onSaved={reload} />
            ))}

          <nav aria-label="Machine" className="flex gap-5 border-b text-sm sm:gap-6">
            {TABS.map(({ tab: each, label }) => (
              <Link
                key={each}
                to={{ search: tabSearch(params, each) }}
                aria-current={each === tab ? "page" : undefined}
                onClick={each === tab ? undefined : keepScroll}
                className={cn(
                  "-mb-px border-b-2 py-2",
                  each === tab ? "border-foreground font-semibold" : "border-transparent font-medium text-muted-foreground hover:text-foreground",
                )}
              >
                {label}
              </Link>
            ))}
          </nav>

          {/* Each mounted only while it is open, so it loads, and the Live View streams, only then. */}
          {tab === "now" && <NowTab machine={machine} askedAt={status.data!.askedAt} changed={changed} />}
          {tab === "activity" && <ActivityTab machine={machine} />}
          {tab === "settings" && <SettingsTab machine={machine} changed={changed} />}
          {tab === "software" && <SoftwareTab machine={machine} changed={changed} />}
          {tab === "setup" && (
            <SetupTab
              machine={machine}
              isAdmin={isAdmin}
              changed={changed}
              onChanged={reload}
              onIssued={(token) => {
                setIssued(token);
                return reload();
              }}
            />
          )}
        </>
      )}
    </section>
  );
}

/**
 * What heads the page, whichever tab is open: the Machine's name, with
 * whether it is online and anything about its identity or sharing to flag;
 * links to its Shots and Steam Records; and one line with what it is doing,
 * or, offline, when it was last seen and what it was doing then, its last
 * Shot, marked where out of spec, and where it is. Its times are by its
 * Location's clock, or the browser's while it is at none.
 */
function MachineHeading({ machine }: { machine: Machine }) {
  const timeZone = machine.location?.timeZone;
  const state = machine.machineState && describeMachineState(machine.machineState);
  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <h1 className="text-2xl font-semibold wrap-anywhere">{machine.name}</h1>
          <StatusBadge machine={machine} />
          <IdentificationBadge identification={machine.identification} />
          <CaptureOnlyBadge machine={machine} />
        </div>
        <div className="flex items-center gap-4 text-sm font-medium">
          <Link to={`/shots?machineId=${machine.id}`} className="underline-offset-4 hover:underline">
            Shots
          </Link>
          <Link to={`/steam-records?machineId=${machine.id}`} className="underline-offset-4 hover:underline">
            Steam Records
          </Link>
        </div>
      </div>
      <div role="group" aria-label="Status" className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-sm">
        <span>
          {machine.online ? (
            (state ?? "State not reported")
          ) : (
            <>
              <LastSeen machine={machine} timeZone={timeZone} />
              {machine.lastSeenAt !== null && state && `, ${state} then`}
            </>
          )}
        </span>
        <span aria-hidden="true">·</span>
        <LastShot machine={machine} timeZone={timeZone} lead="Last Shot" />
        <span aria-hidden="true" className="text-muted-foreground">
          ·
        </span>
        {machine.location ? (
          <Link to={`/locations/${encodeURIComponent(machine.location.id)}`} className="text-muted-foreground underline-offset-4 hover:underline">
            {machine.location.name}
          </Link>
        ) : (
          <span className="text-muted-foreground">No Location</span>
        )}
      </div>
    </>
  );
}

/** What a tab shows while what it reads of the tablet's reports can't be read, or hasn't been yet. */
function Reading({ error }: { error: string | undefined }) {
  if (!error) return <p className="text-sm text-muted-foreground">Loading</p>;
  return (
    <Alert variant="destructive">
      <AlertDescription>{error}</AlertDescription>
    </Alert>
  );
}

/**
 * The Bean Batch a Machine's Workflow names, as its card shows it (#732):
 * the Library's batch, and where it stands at the Machine's Location now,
 * its Remaining Weight there, null where the Location doesn't track it, or
 * that it is not there (`finished`), finished there, moved away or
 * Archived. `here` is undefined for a Machine at no Location, or where the
 * batch couldn't be read.
 */
interface WorkflowBatch {
  batch: BatchLink;
  here?: { remainingWeight: number | null } | "finished";
}

/**
 * The batch the Machine's current Workflow names, read beside it: from the
 * Workflow's summary, which names it by the Library's Bean, roast date and
 * Batch Code, where that summarises the same Workflow, and the batch's own
 * read, for its Remaining Weight at the Machine's Location. Undefined where
 * the Workflow names no batch the Library holds, the previous release's
 * server answers, which names none (ADR-0025), or either read fails: the
 * card then has no Bean Batch row, and the Workflow is shown all the same.
 */
async function workflowBatch(path: string, workflow: WorkflowEvent | null, location: Location | null): Promise<WorkflowBatch | undefined> {
  if (workflow === null) return undefined;
  try {
    const { workflow: summary } = await api<{ workflow: WorkflowSummaryEvent | null }>("GET", `${path}/workflow-summary`);
    const batch = summary?.id === workflow.id ? summary.workflow.beanBatch : undefined;
    if (!batch) return undefined;
    if (location === null) return { batch };
    try {
      const { batch: read } = await api<{ batch: BeanBatch }>("GET", `/bean-batches/${encodeURIComponent(batch.id)}`);
      const here = read.archived ? undefined : read.locations.find((at) => at.location.id === location.id);
      return { batch, here: here ? { remainingWeight: here.remainingWeight } : "finished" };
    } catch {
      return { batch };
    }
  } catch {
    return undefined;
  }
}

/**
 * Now: the Machine's Live View; its Workflow, as its tablet last reported
 * it, loaded every 30 s, with the Bean Batch it names and the Loaded Recipe
 * it was loaded from; and its Shots by Recipe.
 */
function NowTab({ machine, askedAt, changed }: { machine: Machine; askedAt: number; changed: number }) {
  const path = `/machines/${encodeURIComponent(machine.id)}`;
  const { location } = machine;
  const load = useCallback(async () => {
    const { workflow } = await api<{ workflow: WorkflowEvent | null }>("GET", `${path}/workflow`);
    return { workflow, batch: await workflowBatch(path, workflow, location) };
    // Its Location read again only as it moves.
  }, [path, location?.id]);
  const { data, error, reload } = usePolled(load, DETAILS_POLL_MS);
  useReloadOn(changed, reload);
  const workflow = data?.workflow;
  // Read once per Workflow read, so the Live View's samples are not read again on every render.
  const profile = useMemo(() => profileOf(workflow?.workflow.profile), [workflow]);
  return (
    <>
      <LiveViewCard machine={machine} askedAt={askedAt} profile={profile} />
      {/* Shown once loaded: the Live View does not wait for it. A read that fails says so, over the Workflow read before it. */}
      {(error || workflow === undefined) && <Reading error={error} />}
      {workflow !== undefined && <MachineWorkflow machine={machine} current={workflow} batch={data?.batch} />}
      <MachineShotsCard machine={machine} />
    </>
  );
}

/**
 * Activity: how much the Machine was used, by day or by hour of one day,
 * then what happened on it over one day. The two share that day: choosing a
 * day's bar in Use shows that day's lists, and its hours where Use is by
 * hour. Today, at the Location the Machine is at, until one is chosen.
 */
function ActivityTab({ machine }: { machine: Machine }) {
  const [day, setDay] = useState<string>();
  return (
    <>
      <MachineUseCard machineId={machine.id} day={day} onDay={setDay} />
      <MachineActivityCard machine={machine} day={day} onDay={setDay} />
    </>
  );
}

/** What the Settings tab reads of what the Machine's tablet reported. */
interface SettingsReports {
  /** Its current Workflow, whose steam, hot water and rinse settings the Settings card lists, or null until its tablet reports one. */
  workflow: WorkflowEvent | null;
  pairedDevices: PairedDevices;
  settings: Record<keyof typeof SETTINGS, Collection | null>;
}

/**
 * Settings: the Machine's settings, with their edits, its paired devices,
 * and its Settings History, which lists each Settings Edit too. What its
 * tablet reported is loaded every 30 s, and again as an edit made here is
 * answered.
 */
function SettingsTab({ machine, changed }: { machine: Machine; changed: number }) {
  const path = `/machines/${encodeURIComponent(machine.id)}`;
  const load = useCallback(async (): Promise<SettingsReports> => {
    const settingNames = Object.keys(SETTINGS) as (keyof typeof SETTINGS)[];
    const [{ workflow }, { pairedDevices }, settings] = await Promise.all([
      api<{ workflow: WorkflowEvent | null }>("GET", `${path}/workflow`),
      api<{ pairedDevices: PairedDevices }>("GET", `${path}/paired-devices`),
      Promise.all(settingNames.map((name) => api<{ collection: Collection | null }>("GET", `${path}/collections/${name}`))),
    ]);
    return { workflow, pairedDevices, settings: Object.fromEntries(settingNames.map((name, index) => [name, settings[index]!.collection])) as SettingsReports["settings"] };
  }, [path]);
  const { data, error, reload } = usePolled(load, DETAILS_POLL_MS);
  useReloadOn(changed, reload);
  // Counts the edits answered here, so the Settings History loads them again as each is.
  const [editsAnswered, setEditsAnswered] = useState(0);
  const answered = useCallback(async () => {
    setEditsAnswered((count) => count + 1);
    await reload();
  }, [reload]);
  return (
    <>
      {data ? (
        <>
          {error && <Reading error={error} />}
          <SettingsCard machine={machine} settings={data.settings} workflow={data.workflow} onReported={answered} />
          <PairedDevicesCard devices={data.pairedDevices} />
        </>
      ) : (
        <Reading error={error} />
      )}
      <SettingsHistoryCard machineId={machine.id} answered={editsAnswered} />
    </>
  );
}

/**
 * Setup: the Machine's hardware and firmware, its Location with its Location
 * History, its sharing, the library its tablet reported, its token, for an
 * Admin, and the deliveries set aside. What its tablet reported is loaded
 * every 30 s, and again after a change made on the page.
 */
function SetupTab({
  machine,
  isAdmin,
  changed,
  onChanged,
  onIssued,
}: {
  machine: Machine;
  isAdmin: boolean;
  changed: number;
  onChanged(): Promise<void>;
  onIssued(token: IssuedToken): Promise<void>;
}) {
  const path = `/machines/${encodeURIComponent(machine.id)}`;
  // The collections its tablet has reported, without their values.
  const load = useCallback(async () => (await api<{ collections: CollectionSummary[] }>("GET", `${path}/collections`)).collections, [path]);
  const { data, error, reload } = usePolled(load, DETAILS_POLL_MS);
  useReloadOn(changed, reload);
  return (
    <>
      {error && <Reading error={error} />}
      <HardwareAndSoftware machine={machine} />
      <MachineLocation machine={machine} isAdmin={isAdmin} onChanged={onChanged} />
      <MachineSharingCard machine={machine} isAdmin={isAdmin} onChanged={onChanged} />
      {data && <LibraryCard collections={data} />}
      {isAdmin && <MachineToken machine={machine} onIssued={onIssued} />}
      <SetAsideDeliveriesCard machineId={machine.id} />
    </>
  );
}

/**
 * The Machine's hardware, its firmware and its tablet, and the tablets its
 * connections came from: what its Identity, Versions and Tablets cards held,
 * with when it was last seen. A tablet is known by the id its plugin keeps
 * in Decaid's data, so a reset or replaced tablet shows up as a new one.
 * Decaid, its plugins and its Skins are on the Software tab, which it links
 * to.
 */
function HardwareAndSoftware({ machine }: { machine: Machine }) {
  const [params] = useSearchParams();
  const seen = (tablet: Tablet) => `First seen ${formatTime(tablet.firstSeenAt)}, last seen ${formatTime(tablet.lastSeenAt)}`;
  return (
    <Card role="region" aria-label="Hardware and software">
      <CardHeader>
        <CardTitleWithInfo title="Hardware and software">
          <p>Its firmware is as last reported by its Tablet.</p>
          <p>
            Its tablets are those its connections came from. Resetting a tablet's Decaid data, or replacing the tablet, makes a new one;
            restoring a Decaid backup can bring back the tablet it came from.
          </p>
        </CardTitleWithInfo>
      </CardHeader>
      <CardContent className="grid gap-6">
        <div className="grid gap-6 md:grid-cols-2">
          <section className="grid content-start gap-2">
            <h3 className="font-medium">Hardware</h3>
            <Fields label="Hardware">
              <Field term="Model">{machine.model ?? notReported(machine, "model")}</Field>
              <Field term="Serial">{machine.serial ?? notReported(machine, "serial")}</Field>
              <Field term="Identification">{identificationText(machine)}</Field>
              <Field term="Connection id">{machine.connectionId ?? "None reported"}</Field>
              <Field term="Aliases">{machine.aliases.length > 0 ? machine.aliases.join(", ") : "None"}</Field>
              <Field term="Last seen">{machine.lastSeenAt ? formatTime(machine.lastSeenAt) : "Never"}</Field>
            </Fields>
          </section>
          <section className="grid content-start gap-2">
            <h3 className="font-medium">Software</h3>
            <Fields label="Software">
              <Field term="Firmware">{firmwareText(machine)}</Field>
            </Fields>
            <p className="text-sm text-muted-foreground">
              Decaid, its plugins and its Skins are on the{" "}
              <Link to={{ search: tabSearch(params, "software") }} className="text-foreground underline underline-offset-4">
                Software tab
              </Link>
              .
            </p>
          </section>
        </div>
        <section className="grid gap-2">
          <h3 className="font-medium">Tablet</h3>
          {machine.tablet ? (
            <Fields label="Tablet">
              <Field term="Tablet id">
                <span className="font-mono">{machine.tablet.id}</span>
              </Field>
              <Field term="First seen">{formatTime(machine.tablet.firstSeenAt)}</Field>
              <Field term="Last seen">{formatTime(machine.tablet.lastSeenAt)}</Field>
            </Fields>
          ) : (
            <p className="text-sm text-muted-foreground">No tablet has connected yet.</p>
          )}
        </section>
        {machine.earlierTablets.length > 0 && (
          <section className="grid gap-2">
            <h3 className="font-medium">Earlier tablets</h3>
            <ol aria-label="Earlier tablets" className="grid max-w-2xl divide-y rounded-lg border">
              {machine.earlierTablets.map((tablet) => (
                <li key={tablet.id} className="grid gap-0.5 p-4">
                  <span className="font-mono text-sm wrap-anywhere">{tablet.id}</span>
                  <span className="text-sm text-muted-foreground">{seen(tablet)}</span>
                </li>
              ))}
            </ol>
          </section>
        )}
      </CardContent>
    </Card>
  );
}

/** Issuing the Machine a new token, which an Admin confirms: the page shows it above its tabs, the only time it is shown. */
function MachineToken({ machine, onIssued }: { machine: Machine; onIssued(token: IssuedToken): Promise<void> }) {
  const [error, setError] = useState<string>();

  async function reissue() {
    setError(undefined);
    try {
      await onIssued(await api<IssuedToken>("POST", `/machines/${encodeURIComponent(machine.id)}/token`));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Something went wrong");
    }
  }

  return (
    <Card role="region" aria-label="Token">
      <CardHeader>
        <CardTitleWithInfo title="Token">
          <p>Issue a new token if a tablet is lost or its token was shared. The current token stops working.</p>
        </CardTitleWithInfo>
      </CardHeader>
      <CardContent className="grid gap-3">
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <div>
          <ConfirmButton
            label="Issue new token"
            title={`Issue a new token for ${machine.name}?`}
            description="The current token stops working at once: a tablet using it is disconnected, and cannot connect again until the new token is entered in its plugin's settings."
            confirmLabel="Issue new token"
            variant="destructive"
            onConfirm={() => void reissue()}
          />
        </div>
      </CardContent>
    </Card>
  );
}

function BackLink() {
  return (
    <Link to="/machines" className="text-sm text-muted-foreground hover:text-foreground">
      ← Machines
    </Link>
  );
}

/** An unbound Machine's model or serial: what an Unidentified Machine reports, or nothing yet. */
function notReported(machine: Machine, part: "model" | "serial"): string {
  if (needsHardware(machine) && machine.reported) {
    return part === "model" ? machine.reported.model : `None (its machine reports "${machine.reported.serial}")`;
  }
  return "Not reported yet";
}

function identificationText(machine: Machine): string {
  switch (machine.identification) {
    case "identified":
      return "Identified by its model and serial";
    case "hardwareNotReported":
      if (machine.lastSeenAt === null) return "Hardware not reported: no tablet has connected with its token yet";
      if (machine.model !== null) {
        return "Hardware not reported: its tablet last connected while its machine was off, from a connection id not known to be this Machine's";
      }
      return needsHardware(machine)
        ? "Hardware not reported: its tablet last connected while its machine was off; before that, its machine reported no serial number"
        : "Hardware not reported: its tablet has connected only while its machine was off, so it is not yet bound to any hardware";
    case "unidentified":
      return machine.model === null
        ? "Unidentified: its machine reports no serial number, so it is recognised by its token and connection id"
        : "Unidentified: its token is connecting from a machine that reports no serial number, from a connection id not known to be this Machine's";
    case "mismatch":
      return "Mismatch: its token is connecting from other hardware";
  }
}

/**
 * The firmware of the Machine's own hardware. The server keeps only the
 * firmware of the hardware its token last reported, which during a mismatch,
 * or after one, may be other hardware's: that is named beside it.
 */
function firmwareText(machine: Machine): string {
  const reported = machine.reported;
  if (!reported) return "Not reported";
  const firmware = reported.firmware ?? "Not reported";
  const binding = bindingOf(machine);
  const own = binding ? sameHardware(reported, binding) : !isRealSerial(reported.serial);
  return own ? firmware : `${firmware}, from ${describeHardware(reported)}, which its token last reported`;
}

/**
 * The latest time a tablet took the Machine over from another that was still
 * connected with its token. The tablet replaced waits until the other one has
 * gone, so if it is the one on the machine, nothing reaches the server from
 * it meanwhile.
 */
function TakeoverAlert({ takeover }: { takeover: Takeover }) {
  const describe = (connection: TakeoverConnection) =>
    [
      `Tablet ${connection.tabletId} at ${connection.remoteAddress}`,
      `connection id ${connection.connectionId ?? "not reported"}`,
      `plugin ${connection.pluginVersion}`,
      `Decaid ${connection.decaidVersion}`,
    ].join(", ");
  return (
    <Alert>
      <AlertTitle>Another tablet took over at {formatTime(takeover.at)}</AlertTitle>
      <AlertDescription>
        <p>
          A tablet connected with this Machine's token while another was still connected with it, and took its place.
          The tablet replaced sends nothing until the other one has gone. If it is the tablet on this machine, remove
          this Machine's token from the other tablet's plugin.
        </p>
        <Fields label="Takeover">
          <Field term="Took over">{describe(takeover.replacement)}</Field>
          <Field term="Replaced">{describe(takeover.replaced)}</Field>
        </Fields>
      </AlertDescription>
    </Alert>
  );
}

/** The rows of the Workflow card that come after its Bean and roaster, which its Bean Batch row goes above. */
const AFTER_THE_BEAN = ["Grinder", "Burrs", "Grind setting", "Barista", "Steam", "Hot water", "Rinse"];

/**
 * The Workflow card's Bean Batch row (#732): the batch, linked, with its
 * Batch Code, over its roast day and its Remaining Weight at the Machine's
 * Location, such as "Roasted 17 Nov · 3240 g at Downtown", or "not tracked
 * at Downtown"; "Batch finished here" beside its name, in place of the
 * weight, for a batch that is not at that Location now, as the cafe Skin
 * marks it; and the batch in a line alone for a Machine at no Location.
 */
function WorkflowBatchRow({ machine, batch: { batch, here } }: { machine: Machine; batch: WorkflowBatch }) {
  const { location } = machine;
  if (location === null) return <BatchInLine batch={batch} id={batch.id} />;
  if (here === "finished") return <BatchCell batch={batch} id={batch.id} beside={<Badge variant="destructive">Batch finished here</Badge>} />;
  return <BatchCell batch={batch} id={batch.id} also={here && ` · ${here.remainingWeight === null ? "not tracked" : grams(here.remainingWeight)} at ${location.name}`} />;
}

/**
 * What the Machine is set up to do next, from the Workflow its tablet last
 * reported, with the Library's Bean Batch it names, under its roaster, and
 * the Loaded Recipe it was loaded from, the Recipe its tablet
 * last applied (ADR-0022), with its Recipe Slot and since when, as the
 * Machine's status gives it. The Recipes it had loaded before are listed by
 * day on its Activity tab.
 */
function MachineWorkflow({ machine, current, batch }: { machine: Machine; current: WorkflowEvent | null; batch: WorkflowBatch | undefined }) {
  const recorded: [string, ReactNode][] = current ? workflowFields(current.workflow) : [];
  const after = recorded.findIndex(([term]) => AFTER_THE_BEAN.includes(term));
  const row: [string, ReactNode][] = current && batch ? [["Bean Batch", <WorkflowBatchRow machine={machine} batch={batch} />]] : [];
  const fields = after === -1 ? [...recorded, ...row] : [...recorded.slice(0, after), ...row, ...recorded.slice(after)];
  const loaded = machine.loadedRecipe;
  return (
    <Card role="region" aria-label="Workflow">
      <CardHeader>
        <CardTitleWithInfo title="Workflow">
          <p>{current ? `What it is set up to pull next, as its tablet reported at ${formatTime(current.observedAt)}.` : "What it is set up to pull next."}</p>
          <p>
            Its Loaded Recipe is the Recipe its tablet last applied, in DYE2 or on Streamline's strip, which every change on the machine is
            saved into. Changing the profile there, or applying a favourite, unloads it. Its Activity lists the Recipes it had loaded, day by
            day.
          </p>
        </CardTitleWithInfo>
        {!current && <CardDescription>Its tablet has not reported it yet.</CardDescription>}
      </CardHeader>
      <CardContent className="grid gap-4">
        {loaded ? (
          <p role="group" aria-label="Loaded Recipe" className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
            <span className="text-muted-foreground">Loaded from</span>
            <LoadedRecipeLink loaded={loaded} />
            <span className="text-muted-foreground">since {formatTime(loaded.loadedAt)}</span>
          </p>
        ) : (
          <p role="group" aria-label="Loaded Recipe" className="text-sm text-muted-foreground">
            No Recipe is loaded.
          </p>
        )}
        {current &&
          (fields.length > 0 ? (
            <Fields label="Workflow">
              {fields.map(([term, value]) => (
                <Field key={term} term={term}>
                  {value}
                </Field>
              ))}
            </Fields>
          ) : (
            <p className="text-sm text-muted-foreground">This Workflow has none of the parts shown here.</p>
          ))}
      </CardContent>
    </Card>
  );
}

/**
 * Where the Machine is, moving it, and its Location History, whose times
 * are shown and entered in each entry's Location's time zone. Only Admins
 * correct the history.
 */
function MachineLocation({ machine, isAdmin, onChanged }: { machine: Machine; isAdmin: boolean; onChanged(): Promise<void> }) {
  const mayChange = useMayChange();
  const [editing, setEditing] = useState<string>();
  const [removeError, setRemoveError] = useState<string>();
  // Newest first: where it is now leads.
  const history = [...machine.locationHistory].reverse();
  const current = history[0];

  async function remove(entry: LocationHistoryEntry) {
    setRemoveError(undefined);
    try {
      await api("DELETE", `/machines/${machine.id}/location-history/${entry.id}`);
      await onChanged();
    } catch (caught) {
      setRemoveError(caught instanceof Error ? caught.message : "Something went wrong");
    }
  }

  return (
    <Card role="region" aria-label="Location">
      <CardHeader>
        <CardTitleWithInfo title="Location">
          <p>
            Each Shot is credited to the Location the Machine was at when it was pulled. Shots from before it first arrived at a
            Location have none{isAdmin ? "; correct when it arrived to credit them." : "."}
          </p>
        </CardTitleWithInfo>
      </CardHeader>
      <CardContent className="grid gap-6">
        <Fields label="Location">
          <Field term="Location">{current ? current.location.name : "No Location"}</Field>
          {current && <Field term="Since">{formatInZone(current.effectiveFrom, current.location.timeZone)}</Field>}
        </Fields>

        {mayChange && <MoveForm machine={machine} isAdmin={isAdmin} onMoved={onChanged} />}

        {history.length > 0 && (
          <section className="grid gap-2">
            <h3 className="font-medium">Location History</h3>
            {removeError && (
              <Alert variant="destructive" className="max-w-2xl">
                <AlertDescription>{removeError}</AlertDescription>
              </Alert>
            )}
            <ol aria-label="Location History" className="grid max-w-2xl divide-y rounded-lg border">
              {history.map((entry) => (
                <li key={entry.id} className="p-4">
                  {editing === entry.id && isAdmin ? (
                    <CorrectEntry
                      machine={machine}
                      entry={entry}
                      onSaved={async () => {
                        setEditing(undefined);
                        await onChanged();
                      }}
                      onCancel={() => setEditing(undefined)}
                    />
                  ) : (
                    <div className="flex items-center gap-4">
                      <div className="grid flex-1 gap-0.5">
                        <span className="font-medium">{entry.location.name}</span>
                        <span className="text-sm text-muted-foreground">
                          From {formatInZone(entry.effectiveFrom, entry.location.timeZone)}
                        </span>
                      </div>
                      {isAdmin && (
                        <>
                          <Button variant="outline" aria-label={`Correct arrival at ${entry.location.name}`} onClick={() => setEditing(entry.id)}>
                            Correct
                          </Button>
                          <ConfirmButton
                            label="Remove"
                            title={`Remove ${machine.name}'s arrival at ${entry.location.name}?`}
                            description={`Remove it if it was recorded by mistake. ${removalEffect(machine, entry)}`}
                            confirmLabel="Remove"
                            variant="destructive"
                            onConfirm={() => void remove(entry)}
                          />
                        </>
                      )}
                    </div>
                  )}
                </li>
              ))}
            </ol>
          </section>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * Moves the Machine to another Location from now, or gives an unassigned one
 * its first. Staff move it only from a Location they work at to another.
 */
function MoveForm({ machine, isAdmin, onMoved }: { machine: Machine; isAdmin: boolean; onMoved(): Promise<void> }) {
  const id = useId();
  const { locations: all, error: locationsError } = useLocations();
  const worksAt = useStaffLocationIds();
  const locations = isAdmin ? all : all?.filter((location) => worksAt.has(location.id));
  const [chosenId, setChosenId] = useState("");
  const [error, setError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);
  const choices = locations?.filter((location) => location.id !== machine.location?.id) ?? [];
  // A choice goes when a Staff member stops working there, or the Machine moves there meanwhile.
  const locationId = choices.some((location) => location.id === chosenId) ? chosenId : "";
  const verb = machine.location ? "Move" : "Assign";

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(undefined);
    try {
      await api("POST", `/machines/${machine.id}/location-history`, { locationId });
      setChosenId("");
      await onMoved();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Something went wrong");
    } finally {
      setSubmitting(false);
    }
  }

  if (locationsError) return <p className="text-sm text-destructive">{locationsError}</p>;
  if (!locations) return null;
  if (!isAdmin && !locations.some((location) => location.id === machine.location?.id)) {
    return <p className="text-sm text-muted-foreground">You can move it only while it is at a Location you work at.</p>;
  }
  if (choices.length === 0) {
    if (!isAdmin) return <p className="text-sm text-muted-foreground">There is no other Location you work at to move it to.</p>;
    return (
      <p className="text-sm text-muted-foreground">
        {locations.length === 0 ? "There are no Locations yet. " : "There is no other Location to move it to. "}
        <Link to="/locations" className="underline underline-offset-4">
          Add a Location
        </Link>
      </p>
    );
  }
  return (
    <form aria-label={verb} className="grid max-w-xl gap-3" onSubmit={submit}>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <div className="grid gap-2">
        <Label htmlFor={`${id}-location`}>{verb} to</Label>
        <div className="flex flex-wrap gap-2">
          <Select value={locationId} onValueChange={setChosenId}>
            <SelectTrigger id={`${id}-location`} className="w-64">
              <SelectValue placeholder="Choose a Location" />
            </SelectTrigger>
            <SelectContent>
              {choices.map((location) => (
                <SelectItem key={location.id} value={location.id}>
                  {location.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button type="submit" disabled={submitting || !locationId}>
            {verb}
          </Button>
        </div>
        <p className="text-sm text-muted-foreground">
          {isAdmin
            ? "It is at the new Location from now. If it got there earlier, correct the time in its Location History."
            : "It is at the new Location from now."}
        </p>
      </div>
    </form>
  );
}

/** What removing an entry does to the Machine's Location History, and so to its Shots. */
function removalEffect(machine: Machine, entry: LocationHistoryEntry): string {
  const index = machine.locationHistory.findIndex((candidate) => candidate.id === entry.id);
  const before = machine.locationHistory[index - 1];
  const after = machine.locationHistory[index + 1];
  if (!before) {
    return after
      ? `Shots pulled before it arrived at ${after.location.name} will have no Location.`
      : `${machine.name} will have no Location, and its Shots none.`;
  }
  if (after?.location.id === before.location.id) {
    return `It stayed at ${before.location.name}, so its move back there is removed too, and Shots pulled meanwhile are credited to ${before.location.name}.`;
  }
  return `Shots pulled from then${after ? ` until it moved to ${after.location.name}` : ""} are credited to ${before.location.name}, where it was before.`;
}

/**
 * Corrects an entry: the Location it names, when the Machine arrived there,
 * or both. The time is in the chosen Location's time zone.
 */
function CorrectEntry({
  machine,
  entry,
  onSaved,
  onCancel,
}: {
  machine: Machine;
  entry: LocationHistoryEntry;
  onSaved(): Promise<void>;
  onCancel(): void;
}) {
  const id = useId();
  const { locations } = useLocations();
  const options = locations ?? [entry.location];
  // Each field is null until someone changes it, and until then follows the entry, which the page's
  // polling may update as another Admin corrects it; an unchanged field is not sent.
  const [chosenId, setChosenId] = useState<string | null>(null);
  // An entered time keeps the moment it named where it was entered, whatever Location is chosen
  // after: the field shows only minutes, and cannot tell apart the two occurrences of a repeated hour.
  const [entered, setEntered] = useState<{ text: string; time: string | undefined } | null>(null);
  const [error, setError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);
  const location = (chosenId !== null && options.find((option) => option.id === chosenId)) || entry.location;
  const value = entered
    ? entered.time
      ? toZonedInput(entered.time, location.timeZone)
      : entered.text
    : toZonedInput(entry.effectiveFrom, location.timeZone);

  function chooseLocation(chosen: string) {
    setChosenId(chosen === entry.location.id ? null : chosen);
    // A time that names no moment where it was entered is read again in the chosen Location's zone.
    const zone = options.find((option) => option.id === chosen)?.timeZone ?? location.timeZone;
    if (entered && !entered.time) setEntered({ text: entered.text, time: fromZonedInput(entered.text, zone) });
  }

  function enterTime(text: string) {
    // Entering the recorded time again restores the recorded moment, seconds included.
    const restored = text === toZonedInput(entry.effectiveFrom, location.timeZone);
    setEntered(restored ? null : { text, time: fromZonedInput(text, location.timeZone) });
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (entered && !entered.time) {
      setError(`That time does not exist in ${location.timeZone}, whose clocks skip it. Choose another time`);
      return;
    }
    const correction = {
      ...(chosenId !== null && chosenId !== entry.location.id ? { locationId: chosenId } : {}),
      ...(entered ? { effectiveFrom: entered.time } : {}),
    };
    if (Object.keys(correction).length === 0) {
      onCancel();
      return;
    }
    setSubmitting(true);
    setError(undefined);
    try {
      await api("PATCH", `/machines/${machine.id}/location-history/${entry.id}`, correction);
      await onSaved();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Something went wrong");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form aria-label={`Correct arrival at ${entry.location.name}`} className="grid gap-3" onSubmit={submit}>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <div className="grid gap-2">
        <Label htmlFor={`${id}-location`}>Location</Label>
        <Select value={location.id} onValueChange={chooseLocation}>
          <SelectTrigger id={`${id}-location`} className="w-64">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {options.map((option) => (
              <SelectItem key={option.id} value={option.id}>
                {option.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="grid gap-2">
        <Label htmlFor={`${id}-arrived`}>Arrived</Label>
        <Input
          id={`${id}-arrived`}
          type="datetime-local"
          className="w-64"
          value={value}
          onChange={(event) => enterTime(event.target.value)}
          aria-describedby={`${id}-zone`}
          required
        />
        <p id={`${id}-zone`} className="text-sm text-muted-foreground">
          In {location.name}'s time zone, {location.timeZone}.
        </p>
      </div>
      <div className="flex gap-2">
        <Button type="submit" disabled={submitting}>
          Save
        </Button>
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/** The other hardware a Machine's token reports, and how an Admin resolves it. */
function Mismatch({
  machine,
  pending,
  isAdmin,
  onCreated,
  onDismissed,
}: {
  machine: Machine;
  /** The Pending Machine holding the hardware, null if none does, or undefined while it is loading. */
  pending: PendingMachine | null | undefined;
  isAdmin: boolean;
  onCreated(issued: IssuedToken): void;
  onDismissed(): Promise<void>;
}) {
  const mismatch = machine.mismatch!;
  const hardware = describeHardware(mismatch);

  return (
    <Card role="region" aria-label="Mismatch" className="border-destructive">
      <CardHeader>
        <CardTitle>
          <h2>Mismatch</h2>
        </CardTitle>
        <CardDescription>
          {machine.name}'s token is being used by a tablet reporting {hardware}
          {machine.model && machine.serial
            ? `, not this Machine's ${describeHardware({ model: machine.model, serial: machine.serial })}`
            : ", which is not this Machine's hardware"}
          . The tablet may have moved to another machine.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3 text-sm">
        {mismatch.machine ? (
          <p>
            {hardware} is{" "}
            <Link to={`/machines/${mismatch.machine.id}`} className="underline underline-offset-4">
              {mismatch.machine.name}
            </Link>
            .
            {isAdmin && ` Enter ${mismatch.machine.name}'s token on that tablet, issuing a new one from its page if it is lost.`}
          </p>
        ) : pending ? (
          <>
            <p>
              {pending.dismissed
                ? `${hardware} was dismissed, so this token's connections from it are refused.${isAdmin ? " Creating a machine entry for it brings back what was received for it." : ""}`
                : `No machine entry covers ${hardware}, so what the tablet sends is held as a Pending Machine.${isAdmin ? " Create a machine entry for it and enter the new token on that tablet, or dismiss it to refuse it with this Machine's token." : ""}`}
            </p>
            {isAdmin && <PendingMachineActions pending={pending} onCreated={onCreated} onDismissed={onDismissed} />}
          </>
        ) : (
          pending === null && <p>No machine entry covers {hardware}.</p>
        )}
        {!isAdmin && <p>An Admin can resolve this.</p>}
      </CardContent>
    </Card>
  );
}

/**
 * A bound Machine whose token connects from a machine reporting no serial,
 * from a connection id not known to be its own. The server accepts only the
 * hardware it is bound to, so an Admin either confirms that this is it,
 * which remembers the connection id, or adopts the other machine separately.
 */
function ConfirmHardware({ machine, onSaved }: { machine: Machine; onSaved(): Promise<void> }) {
  const binding = bindingOf(machine)!;
  const hardware = describeHardware(binding);
  const [error, setError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);

  async function confirm() {
    setSubmitting(true);
    setError(undefined);
    try {
      await api("PUT", `/machines/${machine.id}/hardware`, binding);
      await onSaved();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Something went wrong");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card role="region" aria-label="Unidentified Machine" className="max-w-xl border-destructive">
      <CardHeader>
        <CardTitle>
          <h2>Unidentified Machine</h2>
        </CardTitle>
        <CardDescription>
          {machine.name}'s token is connecting from a machine that reports no serial number
          {machine.connectionId ? `, from connection id ${machine.connectionId}` : ""}, which is not known to be{" "}
          {machine.name}'s. If it is {machine.name}, its {hardware}, confirm it and the connection id is remembered. If
          it is another machine, create a machine entry for that machine and enter the new token on its tablet.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => void confirm()} disabled={submitting}>
            Confirm it is {hardware}
          </Button>
          <Button variant="outline" asChild>
            <Link to="/machines">Create a machine entry</Link>
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

/** An Admin entering an unbound Unidentified Machine's model and serial, which makes it identified. */
function EnterHardware({ machine, onSaved }: { machine: Machine; onSaved(): Promise<void> }) {
  const id = useId();
  const [models, setModels] = useState<string[]>([]);
  const [model, setModel] = useState("");
  const [serial, setSerial] = useState("");
  const [error, setError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);
  const reportedModel = machine.reported?.model;

  useEffect(() => {
    api<{ models: string[] }>("GET", "/machines/models").then(
      ({ models }) => {
        setModels(models);
        // What the machine reported is most likely right; an Admin can still change it.
        if (reportedModel && models.includes(reportedModel)) setModel((current) => current || reportedModel);
      },
      (caught: unknown) => setError(caught instanceof Error ? caught.message : "The models could not be loaded"),
    );
  }, [reportedModel]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(undefined);
    try {
      await api("PUT", `/machines/${machine.id}/hardware`, { model, serial });
      await onSaved();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Something went wrong");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card role="region" aria-label="Unidentified Machine" className="max-w-xl border-destructive">
      <CardHeader>
        <CardTitle>
          <h2>Unidentified Machine</h2>
        </CardTitle>
        <CardDescription>
          Its machine reported no serial number, as older DE1s do. Enter the model and serial from the machine's label to
          identify it; its tablet's connection id is remembered so it is recognised again.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form aria-label="Enter hardware" className="grid gap-4" onSubmit={submit}>
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <div className="grid gap-2">
            <Label htmlFor={`${id}-model`}>Model</Label>
            {/* Shown once the models arrive: a value set before its options exist is reset to none. */}
            {models.length > 0 && (
              <Select value={model} onValueChange={setModel}>
                <SelectTrigger id={`${id}-model`} className="w-48">
                  <SelectValue placeholder="Choose a model" />
                </SelectTrigger>
                <SelectContent>
                  {models.map((option) => (
                    <SelectItem key={option} value={option}>
                      {option}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
          <div className="grid gap-2">
            <Label htmlFor={`${id}-serial`}>Serial</Label>
            <Input
              id={`${id}-serial`}
              value={serial}
              onChange={(event) => setSerial(event.target.value)}
              autoComplete="off"
              required
            />
          </div>
          <div>
            <Button type="submit" disabled={submitting}>
              Save hardware
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
