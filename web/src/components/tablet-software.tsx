import { type FormEvent, type ReactNode, useCallback, useEffect, useId, useState } from "react";
import { useIsAdmin } from "@/auth";
import { Field, Fields } from "@/components/fields";
import { CardTitleWithInfo, InfoTip } from "@/components/info-tip";
import { FormError, failure } from "@/components/library-forms";
import { ConfirmButton, formatTime } from "@/components/machines";
import { ScrollsSideways } from "@/components/scrolls-sideways";
import { SettingsEditStatus, SettingsForm } from "@/components/settings-edits";
import { SoftwareActionStatus, SoftwareActionsCard, decaidUpdateText, sourceText } from "@/components/software-actions";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Field as FormField, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  type Machine,
  type PluginSetting,
  type PluginSource,
  type SettingsEdit,
  type SoftwareAction,
  type SoftwareUpdates,
  type TabletPlugin,
  type TabletSkin,
  type TabletSoftware,
  api,
} from "@/lib/api";
import { valueText } from "@/lib/settings-text";
import { DETAILS_POLL_MS, usePolled, useReloadOn } from "@/lib/use-polled";
import { type EditableSettingsField, isEditable, isPluginRepo, sameValue, settingsField } from "@decent-sync/protocol";

// A Machine's Software tab (#660, ADR-0034): its Tablet Software, Decaid,
// the plugins and the Skins, each with its version and how it updates, and
// for an Admin the Software Actions that change them, each made once, while
// the Tablet is connected, and followed in place until it has an outcome,
// with the log of them all. Staff and Viewers read the lists and the log and
// are offered nothing.

/** The notes the automatic update checks' edit shows (#657). */
const AUTOMATIC_UPDATE_CHECK_NOTES = [
  "A change takes effect when Decaid next starts.",
  "While they are off, nothing on the Tablet updates by itself, Decent Sync's plugin included.",
];

/** The automatic update checks' definition, which the Settings Edit that changes them is made by. */
const AUTOMATIC_UPDATE_CHECK = (() => {
  const field = settingsField("appSettings", "automaticUpdateCheck");
  if (!field || !isEditable(field)) throw new Error("The automatic update checks are not editable");
  return field satisfies EditableSettingsField;
})();

/** A Software Action as asked for, by its kind. */
type NewAction =
  | { kind: "installPlugin"; repo: string; branch?: string }
  | { kind: "enablePlugin" | "disablePlugin" | "removePlugin"; pluginId: string }
  | { kind: "approvePluginUpdate"; pluginId: string; version: string; addedPermissions: string[] }
  | { kind: "changePluginSettings"; pluginId: string; values: Record<string, unknown>; expected: Record<string, unknown> }
  | { kind: "checkPluginUpdates" | "checkDecaidUpdate" };

/** Makes a Software Action, answered with its outcome pending; a refusal at once throws with the server's words. */
async function makeAction(machineId: string, action: NewAction): Promise<SoftwareAction> {
  return (await api<{ softwareAction: SoftwareAction }>("POST", `/machines/${encodeURIComponent(machineId)}/software-actions`, action)).softwareAction;
}

/**
 * Why no Software Action can be made now, or null while one can: the Machine
 * is offline, or its Tablet reports another machine's hardware. The server
 * refuses either at once with 409.
 */
export function actionBlocked(machine: Machine): string | null {
  if (!machine.online) return "Software Actions are made only while the Machine is online and its Tablet connected.";
  if (machine.identification === "mismatch") return "Its Tablet reports another machine's hardware than this Machine's, so nothing is asked of it.";
  return null;
}

/** What a place on the tab that makes actions shares: who may, whether they can now, and how one made there is shown. */
interface Acting {
  machine: Machine;
  /** Whether actions are offered: to an Admin, while the Tablet's plugin takes them. */
  offered: boolean;
  /** Why they can't be made now, or null. */
  blocked: string | null;
  plugins: readonly TabletPlugin[] | null;
  /** Reloads the lists and the log once an action made here is answered. */
  onAnswered(): Promise<void>;
}

/**
 * The latest action made from one place, and making one there: its status
 * shown until another is made, and a refusal at once shown with the
 * server's words.
 */
function useMade(machineId: string) {
  const [made, setMade] = useState<SoftwareAction>();
  const [error, setError] = useState<string>();
  const [making, setMaking] = useState(false);
  const make = async (action: NewAction) => {
    setError(undefined);
    setMaking(true);
    try {
      setMade(await makeAction(machineId, action));
    } catch (caught) {
      setError(failure(caught, "The Software Action could not be made"));
    } finally {
      setMaking(false);
    }
  };
  return { made, setMade, error, setError, making, make };
}

/** The status of the latest action made from one place, or the refusal of the one tried. */
function MadeStatus({ acting, made, error }: { acting: Acting; made: SoftwareAction | undefined; error: string | undefined }) {
  return (
    <>
      {error && <FormError error={error} />}
      {made && !error && <SoftwareActionStatus key={made.id} machineId={acting.machine.id} action={made} plugins={acting.plugins} onAnswered={acting.onAnswered} />}
    </>
  );
}

/**
 * Software: the Machine's Tablet Software as its Tablet last reported it,
 * loaded every 30 s, again after a change made on the page and as each
 * action made here is answered; then the Software Actions log, which starts
 * closed. Above the lists, that the Tablet's plugin must update before it
 * takes an action, and that its automatic update checks are off.
 */
export function SoftwareTab({ machine, changed }: { machine: Machine; changed: number }) {
  const isAdmin = useIsAdmin();
  const path = `/machines/${encodeURIComponent(machine.id)}`;
  const load = useCallback(async () => (await api<{ tabletSoftware: TabletSoftware }>("GET", `${path}/tablet-software`)).tabletSoftware, [path]);
  const { data: software, error, reload } = usePolled(load, DETAILS_POLL_MS);
  useReloadOn(changed, reload);
  // Counts the actions answered here, so the log loads them again as each is.
  const [answered, setAnswered] = useState(0);
  const onAnswered = useCallback(async () => {
    setAnswered((count) => count + 1);
    await reload();
  }, [reload]);

  const offered = isAdmin && software?.pluginMustUpdate === false;
  const blocked = actionBlocked(machine);
  const acting: Acting = { machine, offered, blocked, plugins: software?.plugins ?? null, onAnswered };
  return (
    <>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {!software && !error && <p className="text-sm text-muted-foreground">Loading</p>}
      {software && (
        <>
          {software.pluginMustUpdate && (
            <Alert>
              <AlertTitle>The Tablet's plugin must update before it can take a Software Action</AlertTitle>
              <AlertDescription>It runs a release from before Software Actions. Its lists are shown as it last reported them.</AlertDescription>
            </Alert>
          )}
          {software.decaid.automaticUpdateCheck === false && (
            <Alert>
              <AlertTitle>Automatic update checks are off</AlertTitle>
              <AlertDescription>Nothing on the Tablet updates by itself, Decent Sync's plugin included, until they are turned on again.</AlertDescription>
            </Alert>
          )}
          {offered && blocked && <p className="text-sm text-muted-foreground">{blocked}</p>}
          <DecaidCard software={software} acting={acting} />
          <PluginsCard plugins={software.plugins} acting={acting} />
          <SkinsCard skins={software.skins} />
        </>
      )}
      <SoftwareActionsCard machineId={machine.id} plugins={software?.plugins} answered={answered} />
    </>
  );
}

/**
 * Decaid: its version and build, the update it offers as its Tablet last
 * reported, a check for it now, and whether its automatic update checks are
 * on, which an Admin turns on or off with a Settings Edit.
 */
function DecaidCard({ software, acting }: { software: TabletSoftware; acting: Acting }) {
  const { decaid } = software;
  const { made, error, making, make } = useMade(acting.machine.id);
  const [editing, setEditing] = useState(false);
  const [edit, setEdit] = useState<SettingsEdit>();
  const version = decaid.version ? (decaid.build ? `${decaid.version} · build ${decaid.build}` : decaid.version) : "Not reported";
  return (
    <Card role="region" aria-label="Decaid">
      <CardHeader>
        <CardTitleWithInfo title="Decaid">
          <p>The app the Tablet runs, which runs its plugins and serves its Skins, as its Tablet last reported it.</p>
          <p>Decaid's own update is installed by someone at the Tablet, who confirms it there.</p>
        </CardTitleWithInfo>
        {acting.offered && (
          <CardAction>
            <Button variant="outline" size="sm" disabled={making || acting.blocked !== null} onClick={() => void make({ kind: "checkDecaidUpdate" })}>
              Check now
            </Button>
          </CardAction>
        )}
      </CardHeader>
      <CardContent className="grid gap-4">
        <MadeStatus acting={acting} made={made} error={error} />
        <Fields label="Decaid">
          <Field term="Version">{version}</Field>
          <Field term="Update">
            {decaid.update ? (
              <span className="inline-flex items-center gap-1.5">
                {decaidUpdateText(decaid.update)}
                <InfoTip label="About Update">
                  <p>As the Tablet reported at {formatTime(decaid.update.reportedAt)}.</p>
                  {decaid.update.installable && <p>Someone at the Tablet confirms its install there.</p>}
                </InfoTip>
              </span>
            ) : (
              "Not reported yet"
            )}
          </Field>
          <Field term="Automatic update checks">
            <span className="inline-flex flex-wrap items-center gap-1.5">
              {decaid.automaticUpdateCheck === null ? "Not reported yet" : decaid.automaticUpdateCheck ? "On, every 12 hours" : "Off"}
              <InfoTip label="About Automatic update checks">
                <p>While they are on, Decaid checks its plugins and Skins for updates every 12 hours and installs what it finds.</p>
              </InfoTip>
              {acting.offered && decaid.automaticUpdateCheck !== null && !editing && (
                <Button variant="outline" size="sm" aria-label="Edit automatic update checks" disabled={acting.blocked !== null} onClick={() => setEditing(true)}>
                  Edit
                </Button>
              )}
            </span>
          </Field>
        </Fields>
        {edit && <SettingsEditStatus key={edit.id} machineId={acting.machine.id} edit={edit} onAnswered={acting.onAnswered} />}
        {editing && acting.offered && decaid.automaticUpdateCheck !== null && (
          <SettingsForm
            name="appSettings"
            machine={acting.machine}
            offered={[AUTOMATIC_UPDATE_CHECK]}
            reported={{ automaticUpdateCheck: decaid.automaticUpdateCheck }}
            label="Edit automatic update checks"
            notes={() => AUTOMATIC_UPDATE_CHECK_NOTES}
            onCancel={() => setEditing(false)}
            onSaved={(saved) => {
              setEditing(false);
              setEdit(saved);
            }}
          />
        )}
      </CardContent>
    </Card>
  );
}

/** How a plugin or Skin updates, with where from, and what explains it in a tooltip. */
function UpdatesText({ updates }: { updates: SoftwareUpdates }) {
  const [text, about] = updatesText(updates);
  return (
    <span className="inline-flex items-center gap-1.5">
      <span>{text}</span>
      {about && <InfoTip label="About how it updates">{about}</InfoTip>}
    </span>
  );
}

function updatesText(updates: SoftwareUpdates): [text: string, about?: string] {
  switch (updates.how) {
    case "followsReleases":
      return [updates.repo ? `Follows releases · ${updates.repo}` : "Follows releases", "An update check installs the repository's newest release."];
    case "followsBranch":
      return [updates.repo ? `Follows a branch · ${updates.repo}, ${updates.branch}` : `Follows a branch · ${updates.branch}`, "An update check installs the branch's newest commit."];
    case "pinned": {
      const commit = updates.commit ? ` at ${updates.commit.slice(0, 7)}` : "";
      const text = updates.repo ? `Pinned · ${updates.repo}${commit}` : `Pinned${commit}`;
      return [text, updates.url ? `Installed from ${updates.url}, which no update check moves.` : "Installed from one fixed build, which no update check moves."];
    }
    case "followsUrl":
      return ["Follows its URL", `Installed again once what ${updates.url} serves changes.`];
    case "comesWithDecaid":
      return ["Comes with Decaid", "Decaid may put its latest release back when it starts."];
    case "notUpdated":
      return ["Not updated", "Installed from a file or folder, or with no source recorded, so no update check moves it."];
  }
}

/** A plugin by the name it reports, or its id where it reports none. */
function pluginLabel(plugin: TabletPlugin): string {
  return plugin.name ?? plugin.id;
}

/**
 * The plugins on the Tablet, each with its version, how it updates, any
 * update that waits for approval and the permissions it adds, and whether it
 * is enabled; for an Admin, a check for updates, an install, and each one's
 * actions: approving its waiting update, enabling or disabling it, its
 * settings, and removing it, but for Decent Sync's own, which is never
 * disabled or removed from here.
 */
function PluginsCard({ plugins, acting }: { plugins: TabletPlugin[] | null; acting: Acting }) {
  const { made, setMade, error, setError, making, make } = useMade(acting.machine.id);
  const disabled = making || acting.blocked !== null;
  const shown = (action: SoftwareAction) => {
    setError(undefined);
    setMade(action);
  };
  return (
    <Card role="region" aria-label="Plugins">
      <CardHeader>
        <CardTitleWithInfo title="Plugins">
          <p>The plugins Decaid runs on the Tablet, as its Tablet last reported them, with how each updates and from where.</p>
          <p>An update that adds a permission waits for approval, here or at the Tablet.</p>
        </CardTitleWithInfo>
        {!plugins && <CardDescription>Its Tablet has not reported its plugins yet.</CardDescription>}
        {acting.offered && (
          <CardAction className="flex flex-wrap justify-end gap-2">
            <Button variant="outline" size="sm" disabled={disabled} onClick={() => void make({ kind: "checkPluginUpdates" })}>
              Check for updates
            </Button>
            <InstallPluginDialog machine={acting.machine} disabled={disabled} onMade={shown} />
          </CardAction>
        )}
      </CardHeader>
      <CardContent className="grid gap-3">
        <MadeStatus acting={acting} made={made} error={error} />
        {plugins && plugins.length === 0 && <p className="text-sm text-muted-foreground">No plugin is installed.</p>}
        {plugins && plugins.length > 0 && (
          <>
            <ScrollsSideways />
            <Table aria-label="Plugins">
              <TableHeader>
                <TableRow>
                  <TableHead>Plugin</TableHead>
                  <TableHead>Version</TableHead>
                  <TableHead>Updates</TableHead>
                  <TableHead>State</TableHead>
                  {acting.offered && (
                    <TableHead>
                      <span className="sr-only">Actions</span>
                    </TableHead>
                  )}
                </TableRow>
              </TableHeader>
              <TableBody>
                {plugins.map((plugin) => (
                  <TableRow key={plugin.id}>
                    <TableCell className="align-top font-medium whitespace-normal">{pluginLabel(plugin)}</TableCell>
                    <TableCell className="align-top">{plugin.version ?? "Not reported"}</TableCell>
                    <TableCell className="min-w-48 align-top whitespace-normal">
                      <div className="grid gap-0.5">
                        <UpdatesText updates={plugin.updates} />
                        {plugin.pendingUpdate && (
                          <span className="text-muted-foreground">
                            {plugin.pendingUpdate.version ? `${plugin.pendingUpdate.version} waits for approval` : "An update waits for approval"}
                            {plugin.pendingUpdate.addedPermissions.length > 0 && ` · adds: ${plugin.pendingUpdate.addedPermissions.join(", ")}`}
                          </span>
                        )}
                        {plugin.lastError && <span className="text-destructive">The last update check failed: {plugin.lastError}</span>}
                      </div>
                    </TableCell>
                    <TableCell className="align-top">
                      <PluginState plugin={plugin} />
                    </TableCell>
                    {acting.offered && (
                      <TableCell className="align-top">
                        <div className="flex flex-wrap justify-end gap-2">
                          {plugin.pendingUpdate && (
                            <Button
                              size="sm"
                              aria-label={`Approve ${pluginLabel(plugin)}'s update`}
                              disabled={disabled || plugin.pendingUpdate.version === null}
                              onClick={() =>
                                plugin.pendingUpdate?.version &&
                                void make({ kind: "approvePluginUpdate", pluginId: plugin.id, version: plugin.pendingUpdate.version, addedPermissions: plugin.pendingUpdate.addedPermissions })
                              }
                            >
                              Approve
                            </Button>
                          )}
                          {plugin.settings.length > 0 && <PluginSettingsDialog machine={acting.machine} plugin={plugin} disabled={disabled} onMade={shown} />}
                          {!plugin.own &&
                            (plugin.state === "enabled" ? (
                              <Button variant="outline" size="sm" aria-label={`Disable ${pluginLabel(plugin)}`} disabled={disabled} onClick={() => void make({ kind: "disablePlugin", pluginId: plugin.id })}>
                                Disable
                              </Button>
                            ) : (
                              <Button variant="outline" size="sm" aria-label={`Enable ${pluginLabel(plugin)}`} disabled={disabled} onClick={() => void make({ kind: "enablePlugin", pluginId: plugin.id })}>
                                Enable
                              </Button>
                            ))}
                          {!plugin.own && (
                            <ConfirmButton
                              label="Remove"
                              ariaLabel={`Remove ${pluginLabel(plugin)}`}
                              title={`Remove ${pluginLabel(plugin)}?`}
                              description="Its settings on this Tablet are deleted. What it stored stays on the Tablet. If it comes with Decaid, Decaid puts it back when it next starts."
                              confirmLabel="Remove"
                              variant="destructive"
                              disabled={disabled}
                              onConfirm={() => void make({ kind: "removePlugin", pluginId: plugin.id })}
                            />
                          )}
                        </div>
                      </TableCell>
                    )}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function PluginState({ plugin }: { plugin: TabletPlugin }) {
  if (plugin.state === "enabled") return <>Enabled</>;
  if (plugin.state === "disabled") return <>Disabled</>;
  return (
    <span className="inline-flex items-center gap-1.5">
      Enabled, not loaded
      <InfoTip label="About Enabled, not loaded">Decaid loads it as it starts, but it isn't loaded now, as while it updates or where it failed to load.</InfoTip>
    </span>
  );
}

/** The Skins on the Tablet, each with its version and how it updates, the default one marked. Read-only for now (#661). */
function SkinsCard({ skins }: { skins: TabletSkin[] | null }) {
  return (
    <Card role="region" aria-label="Skins">
      <CardHeader>
        <CardTitleWithInfo title="Skins">
          <p>The Skins Decaid can serve on the Tablet, as its Tablet last reported them. The default one is what Decaid shows as it starts.</p>
        </CardTitleWithInfo>
        {!skins && <CardDescription>Its Tablet has not reported its Skins yet.</CardDescription>}
      </CardHeader>
      {skins && (
        <CardContent className="grid gap-3">
          {skins.length === 0 ? (
            <p className="text-sm text-muted-foreground">No Skin is installed.</p>
          ) : (
            <>
              <ScrollsSideways />
              <Table aria-label="Skins">
                <TableHeader>
                  <TableRow>
                    <TableHead>Skin</TableHead>
                    <TableHead>Version</TableHead>
                    <TableHead>Updates</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {skins.map((skin) => (
                    <TableRow key={skin.id}>
                      <TableCell className="align-top font-medium whitespace-normal">
                        <span className="inline-flex flex-wrap items-center gap-2">
                          {skin.name ?? skin.id}
                          {skin.default && <Badge variant="secondary">Default</Badge>}
                          {skin.served && (
                            <Badge variant="outline" className="text-muted-foreground">
                              Showing now
                            </Badge>
                          )}
                        </span>
                      </TableCell>
                      <TableCell className="align-top">{skin.version ?? "Not reported"}</TableCell>
                      <TableCell className="min-w-48 align-top whitespace-normal">
                        <UpdatesText updates={skin.updates} />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </>
          )}
        </CardContent>
      )}
    </Card>
  );
}

/** How a suggested source updates, as its suggestion says it. */
function howShort(updates: SoftwareUpdates): string {
  switch (updates.how) {
    case "pinned":
      return "pinned";
    case "followsBranch":
      return "follows a branch";
    case "followsReleases":
      return "follows releases";
    default:
      return "not updated";
  }
}

/**
 * Installing a plugin on the Tablet: from a GitHub repository's latest
 * release, or from a branch, which it then follows, or a commit, which pins
 * it. The sources the account's other Machines' plugins came from are
 * suggested, and picking one fills the form. Made, the dialog closes and the
 * Plugins card follows the action; refused at once, the dialog says why.
 */
function InstallPluginDialog({ machine, disabled, onMade }: { machine: Machine; disabled: boolean; onMade(action: SoftwareAction): void }) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" disabled={disabled}>
          Install plugin
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Install plugin</DialogTitle>
          <DialogDescription>On {machine.name}</DialogDescription>
        </DialogHeader>
        {/* Mounted only while open, so it starts over each time. */}
        {open && (
          <InstallPluginForm
            machine={machine}
            onCancel={() => setOpen(false)}
            onMade={(action) => {
              setOpen(false);
              onMade(action);
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function InstallPluginForm({ machine, onCancel, onMade }: { machine: Machine; onCancel(): void; onMade(action: SoftwareAction): void }) {
  const id = useId();
  const [sources, setSources] = useState<PluginSource[]>();
  const [repo, setRepo] = useState("");
  const [which, setWhich] = useState<"release" | "branch">("release");
  const [branch, setBranch] = useState("");
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let stopped = false;
    api<{ pluginSources: PluginSource[] }>("GET", `/machines/${encodeURIComponent(machine.id)}/plugin-sources`).then(
      ({ pluginSources }) => !stopped && setSources(pluginSources),
      // The suggestions only help: without them the form still installs.
      () => !stopped && setSources([]),
    );
    return () => {
      stopped = true;
    };
  }, [machine.id]);

  function pick(source: PluginSource) {
    setRepo(source.repo);
    setWhich(source.branch ? "branch" : "release");
    setBranch(source.branch ?? "");
    setError(undefined);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const named = repo.trim();
    const problems = [
      ...(isPluginRepo(named) ? [] : ["Give the GitHub repository as owner/name, such as decentespresso/dye2"]),
      ...(which === "release" || (branch.trim() !== "" && !/\s/.test(branch.trim())) ? [] : ["Give a branch or commit"]),
    ];
    if (problems.length > 0) return setError(problems.join(". "));
    setError(undefined);
    setSaving(true);
    try {
      onMade(await makeAction(machine.id, { kind: "installPlugin", repo: named, ...(which === "branch" ? { branch: branch.trim() } : {}) }));
    } catch (caught) {
      setError(failure(caught, "The plugin could not be installed"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form aria-label="Install plugin" className="grid min-w-0 gap-5" noValidate onSubmit={(event) => void submit(event)}>
      {error && <FormError error={error} />}
      {sources && sources.length > 0 && (
        <section aria-label="In use on your other Machines" className="grid gap-2">
          <h3 className="text-sm font-medium">In use on your other Machines</h3>
          <ul className="grid gap-2">
            {sources.map((source) => (
              <li key={`${source.pluginId} ${source.repo} ${source.branch ?? ""}`}>
                <Button type="button" variant="outline" className="h-auto w-full justify-start py-2 text-left whitespace-normal" onClick={() => pick(source)}>
                  <span className="grid gap-0.5">
                    <span className="font-medium">
                      {source.name ?? source.repo}
                      {source.version ? ` ${source.version}` : ""} · {howShort(source.updates)}
                    </span>
                    <span className="text-xs font-normal text-muted-foreground">
                      {sourceText(source.repo, source.branch)} · on {source.machines} {source.machines === 1 ? "Machine" : "Machines"}
                    </span>
                  </span>
                </Button>
              </li>
            ))}
          </ul>
        </section>
      )}
      <FieldGroup className="gap-4">
        <FormField>
          <FieldLabel htmlFor={`${id}-repo`}>GitHub repository</FieldLabel>
          <Input id={`${id}-repo`} placeholder="owner/name" autoComplete="off" spellCheck={false} value={repo} onChange={(event) => setRepo(event.target.value)} />
        </FormField>
        <div className="grid gap-2">
          <Label id={`${id}-which`}>Install</Label>
          <RadioGroup aria-labelledby={`${id}-which`} value={which} onValueChange={(value) => setWhich(value === "branch" ? "branch" : "release")} className="flex flex-wrap gap-4">
            <div className="flex items-center gap-2">
              <RadioGroupItem id={`${id}-release`} value="release" />
              <Label htmlFor={`${id}-release`} className="font-normal">
                Latest release
              </Label>
            </div>
            <div className="flex items-center gap-2">
              <RadioGroupItem id={`${id}-branch`} value="branch" />
              <Label htmlFor={`${id}-branch`} className="font-normal">
                Branch or commit
              </Label>
            </div>
          </RadioGroup>
        </div>
        {which === "branch" && (
          <FormField>
            <FieldLabel htmlFor={`${id}-branch-name`}>Branch or commit</FieldLabel>
            <Input id={`${id}-branch-name`} autoComplete="off" spellCheck={false} value={branch} onChange={(event) => setBranch(event.target.value)} />
            <FieldDescription>A commit stays pinned. A branch follows its newest commit.</FieldDescription>
          </FormField>
        )}
      </FieldGroup>
      <p className="text-sm text-muted-foreground">A plugin newly installed is not enabled: its row then offers Enable.</p>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={saving}>
          Install
        </Button>
      </DialogFooter>
    </form>
  );
}

/**
 * A plugin's settings, in a form built from what it declares: text, number,
 * on or off and choice fields, and for a secret a field that only replaces
 * it, shown as set or not set, never with its value. A setting Decent
 * Sync's own plugin keeps to the Tablet is shown, not changed.
 */
function PluginSettingsDialog({ machine, plugin, disabled, onMade }: { machine: Machine; plugin: TabletPlugin; disabled: boolean; onMade(action: SoftwareAction): void }) {
  const [open, setOpen] = useState(false);
  const title = `${pluginLabel(plugin)} settings`;
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" aria-label={title} disabled={disabled}>
          Settings
        </Button>
      </DialogTrigger>
      <DialogContent
        className="max-h-[90dvh] overflow-y-auto sm:max-w-lg"
        onOpenAutoFocus={(event) => {
          // The first thing to take the focus may be a setting's info tip, which opens as it does: a field takes it instead.
          const field = (event.currentTarget as HTMLElement).querySelector<HTMLElement>("input, [role='switch'], [role='combobox']");
          if (!field) return;
          event.preventDefault();
          field.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>The fields are the ones the plugin declares.</DialogDescription>
        </DialogHeader>
        {/* Mounted only while open, so nothing typed, a secret least of all, outlives it. */}
        {open && (
          <PluginSettingsForm
            machine={machine}
            plugin={plugin}
            label={title}
            onCancel={() => setOpen(false)}
            onMade={(action) => {
              setOpen(false);
              onMade(action);
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

/** What a settings form holds for each setting: text as typed, a choice by its value, or on or off. */
type Inputs = Record<string, string | boolean>;

/** A setting's value as held, null for one not set; a secret's as whether it is set. */
function held(setting: PluginSetting): unknown {
  if (setting.secret) return setting.value ?? { isSet: false };
  return setting.value ?? null;
}

/** What a setting's input opens with: its value, or its default where none is set; empty for a secret. */
function inputOf(setting: PluginSetting): string | boolean {
  if (setting.secret) return "";
  const value = held(setting) ?? setting.default;
  if (setting.kind === "switch") return value === true;
  return value === null || value === undefined ? "" : String(value);
}

/** The value an input holds, as the action sends it: null for one left empty, which clears it. */
function valueOf(setting: PluginSetting, input: string | boolean): unknown {
  if (setting.kind === "switch") return input === true;
  const text = String(input);
  if (setting.kind === "number") return text.trim() === "" ? null : Number(text);
  return text === "" ? null : text;
}

function PluginSettingsForm({
  machine,
  plugin,
  label,
  onCancel,
  onMade,
}: {
  machine: Machine;
  plugin: TabletPlugin;
  label: string;
  onCancel(): void;
  onMade(action: SoftwareAction): void;
}) {
  const id = useId();
  // The settings as the form opened over them: a report loaded meanwhile changes neither the inputs nor what is expected.
  const [settings] = useState(plugin.settings);
  const changeable = settings.filter((setting) => setting.changeable);
  const [inputs, setInputs] = useState<Inputs>(() => Object.fromEntries(changeable.map((setting) => [setting.name, inputOf(setting)])));
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values: Record<string, unknown> = {};
    const expected: Record<string, unknown> = {};
    const problems: string[] = [];
    for (const setting of changeable) {
      const input = inputs[setting.name]!;
      // A secret is replaced only when something is typed; anything else only once its input differs from how it opened.
      if (setting.secret ? input === "" : input === inputOf(setting)) continue;
      const value = setting.secret ? input : valueOf(setting, input);
      if (!setting.secret && sameValue(value, held(setting))) continue;
      if (setting.kind === "number" && value !== null && !Number.isFinite(value)) {
        problems.push(`${setting.label}: give a number`);
        continue;
      }
      values[setting.name] = value;
      expected[setting.name] = held(setting);
    }
    if (problems.length > 0) return setError(problems.join(". "));
    if (Object.keys(values).length === 0) return onCancel();
    setError(undefined);
    setSaving(true);
    try {
      onMade(await makeAction(machine.id, { kind: "changePluginSettings", pluginId: plugin.id, values, expected }));
    } catch (caught) {
      setError(failure(caught, "The settings could not be changed"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form aria-label={label} className="grid min-w-0 gap-5" noValidate onSubmit={(event) => void submit(event)}>
      {error && <FormError error={error} />}
      <FieldGroup className="gap-4">
        {settings.map((setting) =>
          setting.changeable ? (
            <PluginSettingInput
              key={setting.name}
              id={`${id}-${setting.name}`}
              setting={setting}
              input={inputs[setting.name]!}
              onChange={(input) => setInputs((current) => ({ ...current, [setting.name]: input }))}
            />
          ) : (
            <ShownSetting key={setting.name} setting={setting} />
          ),
        )}
      </FieldGroup>
      <p className="text-sm text-muted-foreground">Saving restarts this plugin on the Tablet.</p>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={saving}>
          Save
        </Button>
      </DialogFooter>
    </form>
  );
}

/** A setting's label, with the description its plugin declares in a tooltip. */
function SettingLabel({ htmlFor, setting, children }: { htmlFor?: string; setting: PluginSetting; children?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {htmlFor ? <FieldLabel htmlFor={htmlFor}>{setting.label}</FieldLabel> : <span className="text-sm font-medium">{setting.label}</span>}
      {setting.description && <InfoTip label={`About ${setting.label}`}>{setting.description}</InfoTip>}
      {children}
    </div>
  );
}

/** Whether a secret is set, as the form says it. */
function secretText(setting: PluginSetting): string {
  const value = setting.value;
  return typeof value === "object" && value !== null && (value as { isSet?: unknown }).isSet === true ? "Set" : "Not set";
}

function PluginSettingInput({ id, setting, input, onChange }: { id: string; setting: PluginSetting; input: string | boolean; onChange(input: string | boolean): void }) {
  if (setting.kind === "switch" && !setting.secret) {
    return (
      <FormField orientation="horizontal">
        <Switch id={id} checked={input === true} onCheckedChange={onChange} />
        <SettingLabel htmlFor={id} setting={setting} />
      </FormField>
    );
  }
  return (
    <FormField>
      <SettingLabel htmlFor={id} setting={setting}>
        {setting.secret && (
          <Badge variant="outline" className="text-muted-foreground">
            {secretText(setting)}
          </Badge>
        )}
      </SettingLabel>
      {setting.secret ? (
        <Input
          id={id}
          type="password"
          autoComplete="new-password"
          placeholder={secretText(setting) === "Set" ? "Type to replace it" : "Type to set it"}
          value={String(input)}
          onChange={(event) => onChange(event.target.value)}
        />
      ) : setting.kind === "choice" ? (
        <Select value={setting.choices.includes(String(input)) ? String(input) : ""} onValueChange={onChange}>
          <SelectTrigger id={id} className="w-full">
            <SelectValue placeholder="Not set" />
          </SelectTrigger>
          <SelectContent>
            {setting.choices.map((choice) => (
              <SelectItem key={choice} value={choice}>
                {choice}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : (
        <Input
          id={id}
          type={setting.kind === "number" ? "number" : "text"}
          inputMode={setting.kind === "number" ? "decimal" : undefined}
          step={setting.kind === "number" ? "any" : undefined}
          autoComplete="off"
          value={String(input)}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
    </FormField>
  );
}

/** A setting no Software Action changes, shown as the Tablet holds it: Decent Sync's own server address and Token. */
function ShownSetting({ setting }: { setting: PluginSetting }) {
  return (
    <div role="group" aria-label={setting.label} className="grid gap-1">
      <SettingLabel setting={setting} />
      <p className="text-sm wrap-anywhere">{setting.secret ? secretText(setting) : setting.value === null || setting.value === undefined ? "Not set" : valueText(setting.value)}</p>
      <p className="text-sm text-muted-foreground">Set on the Tablet, and not changed from here.</p>
    </div>
  );
}
