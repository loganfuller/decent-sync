import { type FormEvent, useCallback, useEffect, useId, useState } from "react";
import { Link, useParams } from "react-router";
import { useIsAdmin, useStaffLocationIds } from "@/auth";
import {
  ConfirmButton,
  IdentificationBadge,
  bindingOf,
  isRealSerial,
  sameHardware,
  PendingMachineActions,
  StatusBadge,
  describeHardware,
  describeMachineState,
  formatTime,
  lastShotText,
  needsHardware,
  useLocations,
} from "@/components/machines";
import { TokenNotice } from "@/components/TokenNotice";
import { Field, Fields } from "@/components/fields";
import { LibraryCard, PairedDevicesCard, SETTINGS, SettingsCard } from "@/components/machine-collections";
import { workflowFields } from "@/components/workflow";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  ApiError,
  api,
  type Collection,
  type CollectionSummary,
  type IssuedToken,
  type LocationHistoryEntry,
  type Machine,
  type PairedDevices,
  type PendingMachine,
  type WorkflowEvent,
} from "@/lib/api";
import { usePolled } from "@/lib/use-polled";
import { formatInZone, fromZonedInput, toZonedInput } from "@/lib/zoned-time";

interface MachineData {
  machine: Machine;
  /** The Pending Machine holding a mismatch's hardware, if one does. */
  pending: PendingMachine | null;
  /** Its current Workflow, or null until its tablet reports one. */
  workflow: WorkflowEvent | null;
  pairedDevices: PairedDevices;
  /** The collections its tablet has reported, without their values. */
  collections: CollectionSummary[];
  settings: Record<keyof typeof SETTINGS, Collection | null>;
}

/**
 * One Machine: its identity, versions and status, its Workflow, paired
 * devices, settings and library, its Location, its token, and resolving its
 * identity. Staff see all of it, and can move it between the Locations they
 * work at; every other change is for Admins.
 */
export function MachinePage() {
  const { id = "" } = useParams();
  // Keyed, so a token or error shown for one Machine never carries over to the next one opened.
  return <MachineDetails key={id} id={id} />;
}

function MachineDetails({ id }: { id: string }) {
  const isAdmin = useIsAdmin();
  const [notFound, setNotFound] = useState(false);
  const load = useCallback(async (): Promise<MachineData> => {
    try {
      const path = `/machines/${encodeURIComponent(id)}`;
      const settingNames = Object.keys(SETTINGS) as (keyof typeof SETTINGS)[];
      const [{ machine }, { workflow }, { pairedDevices }, { collections }, settings] = await Promise.all([
        api<{ machine: Machine }>("GET", path),
        api<{ workflow: WorkflowEvent | null }>("GET", `${path}/workflow`),
        api<{ pairedDevices: PairedDevices }>("GET", `${path}/paired-devices`),
        api<{ collections: CollectionSummary[] }>("GET", `${path}/collections`),
        Promise.all(settingNames.map((name) => api<{ collection: Collection | null }>("GET", `${path}/collections/${name}`))),
      ]);
      const pendingId = machine.mismatch?.pendingMachineId;
      const pending = pendingId
        ? ((await api<{ pendingMachines: PendingMachine[] }>("GET", "/pending-machines")).pendingMachines.find(
            (candidate) => candidate.id === pendingId,
          ) ?? null)
        : null;
      setNotFound(false);
      return {
        machine,
        pending,
        workflow,
        pairedDevices,
        collections,
        settings: Object.fromEntries(settingNames.map((name, index) => [name, settings[index]!.collection])) as MachineData["settings"],
      };
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) setNotFound(true);
      throw error;
    }
  }, [id]);
  const { data, error, reload } = usePolled(load);
  const [issued, setIssued] = useState<IssuedToken>();
  const [actionError, setActionError] = useState<string>();

  async function reissue() {
    setActionError(undefined);
    try {
      setIssued(await api<IssuedToken>("POST", `/machines/${encodeURIComponent(id)}/token`));
      await reload();
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : "Something went wrong");
    }
  }

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

  const machine = data?.machine;
  return (
    <section className="grid gap-6">
      <BackLink />
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {/* Keyed, so a new token never inherits the last one's "Copied". */}
      {issued && <TokenNotice key={issued.token} issued={issued} onDone={() => setIssued(undefined)} />}
      {machine && (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-2xl font-semibold">{machine.name}</h1>
            <StatusBadge machine={machine} />
            <IdentificationBadge identification={machine.identification} />
          </div>

          {machine.lastRefusal && (
            <Alert variant="destructive">
              <AlertTitle>A connection was refused at {formatTime(machine.lastRefusal.at)}</AlertTitle>
              <AlertDescription>{machine.lastRefusal.reason}</AlertDescription>
            </Alert>
          )}

          {machine.mismatch && (
            <Mismatch machine={machine} pending={data.pending} isAdmin={isAdmin} onCreated={created} onDismissed={reload} />
          )}
          {isAdmin &&
            needsHardware(machine) &&
            (machine.model === null ? (
              <EnterHardware machine={machine} onSaved={reload} />
            ) : (
              <ConfirmHardware machine={machine} onSaved={reload} />
            ))}

          <div className="grid gap-4 md:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>
                  <h2>Identity</h2>
                </CardTitle>
              </CardHeader>
              <CardContent>
                <Fields label="Identity">
                  <Field term="Model">{machine.model ?? notReported(machine, "model")}</Field>
                  <Field term="Serial">{machine.serial ?? notReported(machine, "serial")}</Field>
                  <Field term="Identification">{identificationText(machine)}</Field>
                  <Field term="Connection id">{machine.connectionId ?? "None reported"}</Field>
                  <Field term="Aliases">{machine.aliases.length > 0 ? machine.aliases.join(", ") : "None"}</Field>
                </Fields>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>
                  <h2>Status</h2>
                </CardTitle>
              </CardHeader>
              <CardContent>
                <Fields label="Status">
                  <Field term="Status">{machine.online ? "Online" : "Offline"}</Field>
                  <Field term="Last seen">{machine.lastSeenAt ? formatTime(machine.lastSeenAt) : "Never"}</Field>
                  <Field term="Machine state">
                    {machine.machineState
                      ? `${describeMachineState(machine.machineState)}, since ${formatTime(machine.machineState.observedAt)}`
                      : "Not reported yet"}
                  </Field>
                  <Field term="Last Shot">
                    {machine.lastShot ? (
                      <Link to={`/shots/${encodeURIComponent(machine.lastShot.id)}`} className="underline underline-offset-4">
                        {lastShotText(machine)}
                      </Link>
                    ) : (
                      lastShotText(machine)
                    )}
                  </Field>
                  <Field term="Shots">
                    <Link to={`/shots?machineId=${machine.id}`} className="underline underline-offset-4">
                      All its Shots
                    </Link>
                  </Field>
                  <Field term="Steam Records">
                    <Link to={`/steam-records?machineId=${machine.id}`} className="underline underline-offset-4">
                      All its Steam Records
                    </Link>
                  </Field>
                </Fields>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>
                  <h2>Versions</h2>
                </CardTitle>
                <CardDescription>As reported by the latest accepted connection.</CardDescription>
              </CardHeader>
              <CardContent>
                <Fields label="Versions">
                  <Field term="Firmware">{firmwareText(machine)}</Field>
                  <Field term="Decaid">{machine.decaidVersion ?? "Not reported"}</Field>
                  <Field term="Plugin">{machine.pluginVersion ?? "Not reported"}</Field>
                </Fields>
              </CardContent>
            </Card>

            {isAdmin && (
              <Card>
                <CardHeader>
                  <CardTitle>
                    <h2>Token</h2>
                  </CardTitle>
                  <CardDescription>
                    Issue a new token if a tablet is lost or its token was shared. The current token stops working.
                  </CardDescription>
                </CardHeader>
                <CardContent className="grid gap-3">
                  {actionError && (
                    <Alert variant="destructive">
                      <AlertDescription>{actionError}</AlertDescription>
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
            )}
          </div>

          <MachineWorkflow current={data.workflow} />
          <PairedDevicesCard devices={data.pairedDevices} />
          <SettingsCard settings={data.settings} workflow={data.workflow} />
          <LibraryCard collections={data.collections} />
          <MachineLocation machine={machine} isAdmin={isAdmin} onChanged={reload} />
        </>
      )}
    </section>
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

/** What the Machine is set up to do next, from the Workflow its tablet last reported. */
function MachineWorkflow({ current }: { current: WorkflowEvent | null }) {
  const fields = current ? workflowFields(current.workflow) : [];
  return (
    <Card role="region" aria-label="Workflow">
      <CardHeader>
        <CardTitle>
          <h2>Workflow</h2>
        </CardTitle>
        <CardDescription>
          {current
            ? `What it is set up to pull next, as its tablet reported at ${formatTime(current.observedAt)}.`
            : "What it is set up to pull next. Its tablet has not reported it yet."}
        </CardDescription>
      </CardHeader>
      {current && (
        <CardContent>
          {fields.length > 0 ? (
            <Fields label="Workflow">
              {fields.map(([term, value]) => (
                <Field key={term} term={term}>
                  {value}
                </Field>
              ))}
            </Fields>
          ) : (
            <p className="text-sm text-muted-foreground">This Workflow has none of the parts shown here.</p>
          )}
        </CardContent>
      )}
    </Card>
  );
}

/**
 * Where the Machine is, moving it, and its Location History, whose times
 * are shown and entered in each entry's Location's time zone. Only Admins
 * correct the history.
 */
function MachineLocation({ machine, isAdmin, onChanged }: { machine: Machine; isAdmin: boolean; onChanged(): Promise<void> }) {
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
        <CardTitle>
          <h2>Location</h2>
        </CardTitle>
        <CardDescription>
          Each Shot is credited to the Location the Machine was at when it was pulled. Shots from before it first arrived
          at a Location have none{isAdmin ? "; correct when it arrived to credit them." : "."}
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-6">
        <Fields label="Location">
          <Field term="Location">{current ? current.location.name : "No Location"}</Field>
          {current && <Field term="Since">{formatInZone(current.effectiveFrom, current.location.timeZone)}</Field>}
        </Fields>

        <MoveForm machine={machine} isAdmin={isAdmin} onMoved={onChanged} />

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
                  {editing === entry.id ? (
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
  const [locationId, setLocationId] = useState("");
  const [error, setError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);
  const choices = locations?.filter((location) => location.id !== machine.location?.id) ?? [];
  const verb = machine.location ? "Move" : "Assign";

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(undefined);
    try {
      await api("POST", `/machines/${machine.id}/location-history`, { locationId });
      setLocationId("");
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
          <Select value={locationId} onValueChange={setLocationId}>
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
  pending: PendingMachine | null;
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
          <p>No machine entry covers {hardware}.</p>
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
