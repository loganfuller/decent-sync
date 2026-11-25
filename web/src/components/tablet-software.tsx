import { EllipsisIcon } from "lucide-react";
import { type FormEvent, type ReactNode, type Ref, useCallback, useEffect, useId, useRef, useState } from "react";
import { useIsAdmin, useMayChange } from "@/auth";
import { Field, Fields } from "@/components/fields";
import { CardTitleWithInfo, InfoTip } from "@/components/info-tip";
import { FormError, failure, useMayChangeAt } from "@/components/library-forms";
import { ConfirmButton, ConfirmDialog, formatTime } from "@/components/machines";
import { SettingsEditStatus, SettingsForm } from "@/components/settings-edits";
import { SoftwareActionStatus, SoftwareActionsCard, decaidUpdateText, skinSourceText, sourceText } from "@/components/software-actions";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Field as FormField, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Item, ItemActions, ItemContent, ItemDescription, ItemTitle } from "@/components/ui/item";
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
  type SkinSource,
  type SoftwareAction,
  type SoftwareUpdates,
  type TabletPlugin,
  type TabletShowing,
  type TabletSkin,
  type TabletSoftware,
  api,
} from "@/lib/api";
import { valueText } from "@/lib/settings-text";
import { DETAILS_POLL_MS, usePolled, useReloadOn } from "@/lib/use-polled";
import { useNarrowScreen } from "@/lib/use-screen";
import { type EditableSettingsField, isEditable, isPluginRepo, isSkinUrl, namesCommit, sameValue, settingsField } from "@decent-sync/protocol";

// A Machine's Software tab (#660, #661, ADR-0034): its Tablet Software,
// Decaid, the plugins and the Skins, each with its version and how it
// updates, what the Tablet shows, and for an Admin the Software Actions that
// change them, each made once, while the Tablet is connected, and followed
// in place until it has an outcome, with the log of them all. Staff at the
// Machine's Location may reload the Skin and restart the Skin view, and are
// offered nothing else; other Staff and Viewers read the lists and the log
// and are offered nothing.

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

/** A card's group's actions on a narrow screen: under the text they belong to, sharing its width. */
const ITEM_ACTIONS_WHEN_NARROW = "w-full flex-wrap *:flex-1";

/** A Software Action as asked for, by its kind. */
type NewAction =
  | { kind: "installPlugin"; repo: string; branch?: string }
  | { kind: "enablePlugin" | "disablePlugin" | "removePlugin"; pluginId: string }
  | { kind: "approvePluginUpdate"; pluginId: string; version: string; addedPermissions: string[] }
  | { kind: "changePluginSettings"; pluginId: string; values: Record<string, unknown>; expected: Record<string, unknown> }
  | { kind: "installSkin"; repo: string; branch?: string }
  | { kind: "installSkin"; url: string }
  | { kind: "chooseDefaultSkin" | "removeSkin"; skinId: string }
  | { kind: "checkPluginUpdates" | "checkDecaidUpdate" | "startDecaidUpdate" | "checkSkinUpdates" | "reloadSkin" | "restartSkinView" };

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
  /** Whether Reload and the restart of the Skin view are offered: to an Admin, and to Staff at the Machine's Location, while the Tablet's plugin takes them. */
  skinViewOffered: boolean;
  /** Why they can't be made now, or null. */
  blocked: string | null;
  plugins: readonly TabletPlugin[] | null;
  skins: readonly TabletSkin[] | null;
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
      {made && !error && (
        <SoftwareActionStatus key={made.id} machineId={acting.machine.id} action={made} plugins={acting.plugins} skins={acting.skins} onAnswered={acting.onAnswered} />
      )}
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
  const mayChange = useMayChange();
  const mayChangeAt = useMayChangeAt();
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
  // Staff only at the Machine's Location, as the server judges by it.
  const skinViewOffered = mayChange && mayChangeAt(machine.location?.id ?? null) && software?.pluginMustUpdate === false;
  const blocked = actionBlocked(machine);
  const acting: Acting = { machine, offered, skinViewOffered, blocked, plugins: software?.plugins ?? null, skins: software?.skins ?? null, onAnswered };
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
          {(offered || skinViewOffered) && blocked && <p className="text-sm text-muted-foreground">{blocked}</p>}
          <DecaidCard software={software} acting={acting} />
          <PluginsCard plugins={software.plugins} acting={acting} />
          <SkinsCard skins={software.skins} showing={software.showing ?? null} acting={acting} />
        </>
      )}
      <SoftwareActionsCard machineId={machine.id} plugins={software?.plugins} skins={software?.skins} answered={answered} />
    </>
  );
}

/**
 * Decaid: its version and build, the update it offers as its Tablet last
 * reported, a check for it now, and whether its automatic update checks are
 * on, which an Admin turns on or off with a Settings Edit.
 */
function DecaidCard({ software, acting }: { software: TabletSoftware; acting: Acting }) {
  const narrow = useNarrowScreen();
  const { decaid } = software;
  const { made, error, making, make } = useMade(acting.machine.id);
  const [editing, setEditing] = useState(false);
  const [edit, setEdit] = useState<SettingsEdit>();
  const version = decaid.version ? (decaid.build ? `${decaid.version} · build ${decaid.build}` : decaid.version) : "Not reported";
  // The version Decaid offers to install, while it is not checking, downloading or installing: it ignores the command then.
  const update =
    decaid.update?.installable && decaid.update.latestVersion && !decaid.update.error && !["checking", "downloading", "installing"].includes(decaid.update.phase ?? "")
      ? decaid.update.latestVersion
      : null;
  return (
    <Card role="region" aria-label="Decaid">
      <CardHeader>
        <CardTitleWithInfo title="Decaid">
          <p>The app the Tablet runs, which runs its plugins and serves its Skins, as its Tablet last reported it.</p>
          <p>Decaid's own update can be started from here. Someone at the Tablet then confirms it in Android's installer and taps Open, as Decaid does not reopen by itself.</p>
        </CardTitleWithInfo>
        {acting.offered && (
          <CardAction>
            <Button variant="outline" size={narrow ? "default" : "sm"} disabled={making || acting.blocked !== null} onClick={() => void make({ kind: "checkDecaidUpdate" })}>
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
                  {decaid.update.installable && <p>Someone at the Tablet confirms it in Android's installer and taps Open once it is installed, as Decaid does not reopen by itself.</p>}
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
                <Button variant="outline" size={narrow ? "default" : "sm"} aria-label="Edit automatic update checks" disabled={acting.blocked !== null} onClick={() => setEditing(true)}>
                  Edit
                </Button>
              )}
            </span>
          </Field>
        </Fields>
        {acting.offered && update && (
          <Item variant="outline" role="group" aria-label="Decaid's update" className="bg-muted/40">
            <ItemContent className="min-w-48">
              <ItemDescription className="line-clamp-none text-foreground">
                Decaid {update} can be installed. Someone at the Tablet confirms it and taps Open once it is, as Decaid does not reopen by itself.
              </ItemDescription>
            </ItemContent>
            <ItemActions className={narrow ? ITEM_ACTIONS_WHEN_NARROW : "flex-wrap"}>
              <ConfirmButton
                label="Start the update on the Tablet"
                title="Start Decaid's update on the Tablet?"
                description={`Decaid downloads ${update} and installs it through Android's installer. Someone at the Tablet must then confirm the update in the installer and tap Open: Decaid does not reopen by itself, and the Machine is offline until it does.`}
                confirmLabel="Start the update"
                size={narrow ? undefined : "sm"}
                disabled={making || acting.blocked !== null}
                onConfirm={() => void make({ kind: "startDecaidUpdate" })}
              />
            </ItemActions>
          </Item>
        )}
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
  // A plugin's settings open in its row, in the table or the list: the layout holds while they are open.
  const [settingsOpen, setSettingsOpen] = useState(false);
  const narrow = useNarrowScreen(settingsOpen);
  const { made, setMade, error, setError, making, make } = useMade(acting.machine.id);
  const disabled = making || acting.blocked !== null;
  const shown = (action: SoftwareAction) => {
    setError(undefined);
    setMade(action);
  };
  const rows: PluginRows = { plugins: plugins ?? [], acting, disabled, make, shown, settingsOpened: setSettingsOpen };
  return (
    <Card role="region" aria-label="Plugins">
      <CardHeader>
        <CardTitleWithInfo title="Plugins">
          <p>The plugins Decaid runs on the Tablet, as its Tablet last reported them, with how each updates and from where.</p>
          <p>An update that adds a permission waits for approval, here or at the Tablet.</p>
        </CardTitleWithInfo>
        {!plugins && <CardDescription>Its Tablet has not reported its plugins yet.</CardDescription>}
        {acting.offered && (
          <CardButtons narrow={narrow}>
            <Button variant="outline" size={narrow ? "default" : "sm"} disabled={disabled} onClick={() => void make({ kind: "checkPluginUpdates" })}>
              Check for updates
            </Button>
            <InstallPluginDialog machine={acting.machine} disabled={disabled} narrow={narrow} onMade={shown} />
          </CardButtons>
        )}
      </CardHeader>
      <CardContent className="grid gap-3">
        <MadeStatus acting={acting} made={made} error={error} />
        {plugins && plugins.length === 0 && <p className="text-sm text-muted-foreground">No plugin is installed.</p>}
        {plugins && plugins.length > 0 && (narrow ? <PluginsList {...rows} /> : <PluginsTable {...rows} />)}
      </CardContent>
    </Card>
  );
}

/**
 * A card's own actions: on a wide screen beside its title, as its `CardAction`,
 * and on a narrow screen under it, sharing the card's width. It is the same
 * element either way, so an install dialog open in it, and what was typed
 * there, stays as the screen turns past the breakpoint.
 */
function CardButtons({ narrow, children }: { narrow: boolean; children: ReactNode }) {
  return (
    <div
      data-slot={narrow ? undefined : "card-action"}
      className={narrow ? "mt-2 flex flex-wrap gap-2 *:flex-1" : "col-start-2 row-span-2 row-start-1 flex flex-wrap justify-end gap-2 self-start justify-self-end"}
    >
      {children}
    </div>
  );
}

/** What the plugins' table and their list on a narrow screen share: the plugins, and making an action on one. */
interface PluginRows {
  plugins: TabletPlugin[];
  acting: Acting;
  disabled: boolean;
  make(action: NewAction): Promise<void>;
  /** Shows an action made from a dialog. */
  shown(action: SoftwareAction): void;
  /** Whether a plugin's settings are open, holding the layout meanwhile. */
  settingsOpened(open: boolean): void;
}

/** What waits for approval of a plugin's update, with the permissions it adds. */
function pendingText(pending: NonNullable<TabletPlugin["pendingUpdate"]>): string {
  const waits = pending.version ? `${pending.version} waits for approval` : "An update waits for approval";
  return pending.addedPermissions.length > 0 ? `${waits} · adds: ${pending.addedPermissions.join(", ")}` : waits;
}

/** Approving a plugin's waiting update, a button of its own at either width. */
function ApproveButton({ plugin, disabled, narrow, make }: { plugin: TabletPlugin; disabled: boolean; narrow: boolean; make(action: NewAction): Promise<void> }) {
  const pending = plugin.pendingUpdate;
  if (!pending) return null;
  return (
    <Button
      size={narrow ? "default" : "sm"}
      aria-label={`Approve ${pluginLabel(plugin)}'s update`}
      disabled={disabled || pending.version === null}
      onClick={() => pending.version && void make({ kind: "approvePluginUpdate", pluginId: plugin.id, version: pending.version, addedPermissions: pending.addedPermissions })}
    >
      Approve
    </Button>
  );
}

/** What removing a plugin asks to confirm. */
const REMOVE_PLUGIN = "Its settings on this Tablet are deleted. What it stored stays on the Tablet. If it comes with Decaid, Decaid puts it back when it next starts.";

/** The plugins on a wide screen: a table, with each one's actions as buttons at the end of its row. */
function PluginsTable({ plugins, acting, disabled, make, shown, settingsOpened }: PluginRows) {
  return (
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
                {plugin.pendingUpdate && <span className="text-muted-foreground">{pendingText(plugin.pendingUpdate)}</span>}
                {plugin.lastError && <span className="text-destructive">The last update check failed: {plugin.lastError}</span>}
              </div>
            </TableCell>
            <TableCell className="align-top">
              <PluginState plugin={plugin} />
            </TableCell>
            {acting.offered && (
              <TableCell className="align-top">
                <div className="flex flex-wrap justify-end gap-2">
                  <ApproveButton plugin={plugin} disabled={disabled} narrow={false} make={make} />
                  {plugin.settings.length > 0 && <PluginSettingsDialog machine={acting.machine} plugin={plugin} disabled={disabled} onMade={shown} onOpened={settingsOpened} />}
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
                      description={REMOVE_PLUGIN}
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
  );
}

/**
 * The plugins on a narrow screen (#674): a list, a row for each with its name, its
 * version and state, how it updates, and any update waiting for approval or
 * failed update check, then a button approving that update; its other
 * actions are in one menu at the row's end, where it has any.
 */
function PluginsList({ plugins, acting, disabled, make, shown, settingsOpened }: PluginRows) {
  return (
    <ul aria-label="Plugins" className="divide-y rounded-lg border">
      {plugins.map((plugin) => (
        <li key={plugin.id} className="flex items-start gap-2 px-3 py-2.5">
          <div className="grid min-w-0 flex-1 justify-items-start gap-1 wrap-anywhere">
            <span className="font-medium">{pluginLabel(plugin)}</span>
            <span>
              {plugin.version ?? "Not reported"} · <PluginState plugin={plugin} />
            </span>
            <UpdatesText updates={plugin.updates} />
            {plugin.pendingUpdate && <span className="text-muted-foreground">{pendingText(plugin.pendingUpdate)}</span>}
            {plugin.lastError && <span className="text-destructive">The last update check failed: {plugin.lastError}</span>}
            {acting.offered && plugin.pendingUpdate && (
              <div className="mt-1">
                <ApproveButton plugin={plugin} disabled={disabled} narrow make={make} />
              </div>
            )}
          </div>
          {acting.offered && <PluginMenu plugin={plugin} acting={acting} disabled={disabled} make={make} shown={shown} settingsOpened={settingsOpened} />}
        </li>
      ))}
    </ul>
  );
}

/** A row's actions on a narrow screen: a menu button named for its row, at the row's end. */
function RowMenuButton({ name, ref }: { name: string; ref: Ref<HTMLButtonElement> }) {
  return (
    <DropdownMenuTrigger asChild>
      <Button ref={ref} variant="outline" size="icon" aria-label={`Actions for ${name}`}>
        <EllipsisIcon />
      </Button>
    </DropdownMenuTrigger>
  );
}

/**
 * Keeps track of the dialog a row's menu opened, which has no trigger of its
 * own for the keyboard's focus to go back to as it closes: it goes back to
 * the menu's button.
 */
function useMenuDialog<Which extends string>() {
  const [open, setOpen] = useState<Which>();
  const button = useRef<HTMLButtonElement>(null);
  const opened = (which: Which) => ({
    open: open === which,
    onOpenChange: (next: boolean) => !next && setOpen(undefined),
    onCloseAutoFocus: (event: Event) => {
      event.preventDefault();
      button.current?.focus();
    },
  });
  return { button, open: setOpen, opened };
}

/**
 * A plugin's actions on a narrow screen, in one menu: its settings, enabling or
 * disabling it, and removing it, set apart and behind a confirmation; none
 * for Decent Sync's own but its settings, and no menu where it has none.
 */
function PluginMenu({ plugin, acting, disabled, make, shown, settingsOpened }: { plugin: TabletPlugin } & Omit<PluginRows, "plugins">) {
  const { button, open, opened } = useMenuDialog<"settings" | "remove">();
  const name = pluginLabel(plugin);
  const settings = plugin.settings.length > 0;
  if (!settings && plugin.own) return null;
  return (
    <>
      <DropdownMenu>
        <RowMenuButton name={name} ref={button} />
        <DropdownMenuContent align="end" className="w-44">
          {settings && (
            <DropdownMenuItem aria-label={`${name} settings`} disabled={disabled} onSelect={() => open("settings")}>
              Settings
            </DropdownMenuItem>
          )}
          {!plugin.own &&
            (plugin.state === "enabled" ? (
              <DropdownMenuItem aria-label={`Disable ${name}`} disabled={disabled} onSelect={() => void make({ kind: "disablePlugin", pluginId: plugin.id })}>
                Disable
              </DropdownMenuItem>
            ) : (
              <DropdownMenuItem aria-label={`Enable ${name}`} disabled={disabled} onSelect={() => void make({ kind: "enablePlugin", pluginId: plugin.id })}>
                Enable
              </DropdownMenuItem>
            ))}
          {!plugin.own && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" aria-label={`Remove ${name}`} disabled={disabled} onSelect={() => open("remove")}>
                Remove
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      {settings && <PluginSettingsDialog machine={acting.machine} plugin={plugin} disabled={disabled} onMade={shown} onOpened={settingsOpened} opened={opened("settings")} />}
      {!plugin.own && (
        <ConfirmDialog
          {...opened("remove")}
          title={`Remove ${name}?`}
          description={REMOVE_PLUGIN}
          confirmLabel="Remove"
          variant="destructive"
          onConfirm={() => void make({ kind: "removePlugin", pluginId: plugin.id })}
        />
      )}
    </>
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

/** A Skin by the name it reports, or its id where it reports none. */
function skinLabel(skin: { id: string; name: string | null }): string {
  return skin.name ?? skin.id;
}

/**
 * The Skins on the Tablet, each with its version and how it updates, the
 * default one and the one showing marked, under a strip saying what the
 * Tablet shows; for an Admin, a check for updates, an install, and on each
 * row making it the default and, for one neither the default, nor the one
 * served, nor one that comes with Decaid, removing it behind a confirmation.
 */
function SkinsCard({ skins, showing, acting }: { skins: TabletSkin[] | null; showing: TabletShowing | null; acting: Acting }) {
  const narrow = useNarrowScreen();
  const { made, setMade, error, setError, making, make } = useMade(acting.machine.id);
  const disabled = making || acting.blocked !== null;
  const shown = (action: SoftwareAction) => {
    setError(undefined);
    setMade(action);
  };
  const rows: SkinRows = { skins: skins ?? [], acting, disabled, make };
  return (
    <Card role="region" aria-label="Skins">
      <CardHeader>
        <CardTitleWithInfo title="Skins">
          <p>The Skins Decaid can serve on the Tablet, as its Tablet last reported them. The default one is what Decaid shows as it starts and once its Skin view restarts.</p>
        </CardTitleWithInfo>
        {!skins && <CardDescription>Its Tablet has not reported its Skins yet.</CardDescription>}
        {acting.offered && skins && (
          <CardButtons narrow={narrow}>
            <Button variant="outline" size={narrow ? "default" : "sm"} aria-label="Check Skins for updates" disabled={disabled} onClick={() => void make({ kind: "checkSkinUpdates" })}>
              Check for updates
            </Button>
            <InstallSkinDialog machine={acting.machine} disabled={disabled} narrow={narrow} onMade={shown} />
          </CardButtons>
        )}
      </CardHeader>
      {skins && (
        <CardContent className="grid gap-3">
          <MadeStatus acting={acting} made={made} error={error} />
          {showing && <ShowingStrip skins={skins} showing={showing} acting={acting} disabled={disabled} narrow={narrow} make={make} />}
          {skins.length === 0 ? <p className="text-sm text-muted-foreground">No Skin is installed.</p> : narrow ? <SkinsList {...rows} /> : <SkinsTable {...rows} />}
        </CardContent>
      )}
    </Card>
  );
}

/** What the Skins' table and their list on a narrow screen share: the Skins, and making an action on one. */
interface SkinRows {
  skins: TabletSkin[];
  acting: Acting;
  disabled: boolean;
  make(action: NewAction): Promise<void>;
}

/** What removing a Skin asks to confirm. */
const REMOVE_SKIN = "Decaid deletes it from the Tablet. It can be installed again from here.";

/** A Skin's name, marked where it is the default and where it is showing now. */
function SkinName({ skin }: { skin: TabletSkin }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      {skinLabel(skin)}
      {skin.default && <Badge variant="secondary">Default</Badge>}
      {skin.served && (
        <Badge variant="outline" className="text-muted-foreground">
          Showing now
        </Badge>
      )}
    </span>
  );
}

/** The Skins on a wide screen: a table, with each one's actions as buttons at the end of its row. */
function SkinsTable({ skins, acting, disabled, make }: SkinRows) {
  return (
    <Table aria-label="Skins">
      <TableHeader>
        <TableRow>
          <TableHead>Skin</TableHead>
          <TableHead>Version</TableHead>
          <TableHead>Updates</TableHead>
          {acting.offered && (
            <TableHead>
              <span className="sr-only">Actions</span>
            </TableHead>
          )}
        </TableRow>
      </TableHeader>
      <TableBody>
        {skins.map((skin) => (
          <TableRow key={skin.id}>
            <TableCell className="align-top font-medium whitespace-normal">
              <SkinName skin={skin} />
            </TableCell>
            <TableCell className="align-top">{skin.version ?? "Not reported"}</TableCell>
            <TableCell className="min-w-48 align-top whitespace-normal">
              <UpdatesText updates={skin.updates} />
            </TableCell>
            {acting.offered && (
              <TableCell className="align-top">
                <div className="flex flex-wrap justify-end gap-2">
                  {!skin.default && (
                    <Button variant="outline" size="sm" aria-label={`Make ${skinLabel(skin)} the default`} disabled={disabled} onClick={() => void make({ kind: "chooseDefaultSkin", skinId: skin.id })}>
                      Make default
                    </Button>
                  )}
                  {skin.removable && (
                    <ConfirmButton
                      label="Remove"
                      ariaLabel={`Remove ${skinLabel(skin)}`}
                      title={`Remove ${skinLabel(skin)}?`}
                      description={REMOVE_SKIN}
                      confirmLabel="Remove"
                      variant="destructive"
                      size="sm"
                      disabled={disabled}
                      onConfirm={() => void make({ kind: "removeSkin", skinId: skin.id })}
                    />
                  )}
                </div>
              </TableCell>
            )}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

/**
 * The Skins on a narrow screen (#674): a list, a row for each with its name and
 * marks, its version and how it updates; its actions are in one menu at the
 * row's end, where it has any.
 */
function SkinsList({ skins, acting, disabled, make }: SkinRows) {
  return (
    <ul aria-label="Skins" className="divide-y rounded-lg border">
      {skins.map((skin) => (
        <li key={skin.id} className="flex items-start gap-2 px-3 py-2.5">
          <div className="grid min-w-0 flex-1 justify-items-start gap-1 wrap-anywhere">
            <span className="font-medium">
              <SkinName skin={skin} />
            </span>
            <span>{skin.version ?? "Not reported"}</span>
            <UpdatesText updates={skin.updates} />
          </div>
          {acting.offered && <SkinMenu skin={skin} disabled={disabled} make={make} />}
        </li>
      ))}
    </ul>
  );
}

/**
 * A Skin's actions on a narrow screen, in one menu: making it the default, and
 * removing it, set apart and behind a confirmation; no menu where it has
 * neither, as the default one's.
 */
function SkinMenu({ skin, disabled, make }: { skin: TabletSkin; disabled: boolean; make(action: NewAction): Promise<void> }) {
  const { button, open, opened } = useMenuDialog<"remove">();
  const name = skinLabel(skin);
  if (skin.default && !skin.removable) return null;
  return (
    <>
      <DropdownMenu>
        <RowMenuButton name={name} ref={button} />
        <DropdownMenuContent align="end" className="w-44">
          {!skin.default && (
            <DropdownMenuItem aria-label={`Make ${name} the default`} disabled={disabled} onSelect={() => void make({ kind: "chooseDefaultSkin", skinId: skin.id })}>
              Make default
            </DropdownMenuItem>
          )}
          {skin.removable && (
            <>
              {!skin.default && <DropdownMenuSeparator />}
              <DropdownMenuItem variant="destructive" aria-label={`Remove ${name}`} disabled={disabled} onSelect={() => open("remove")}>
                Remove
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      {skin.removable && (
        <ConfirmDialog
          {...opened("remove")}
          title={`Remove ${name}?`}
          description={REMOVE_SKIN}
          confirmLabel="Remove"
          variant="destructive"
          onConfirm={() => void make({ kind: "removeSkin", skinId: skin.id })}
        />
      )}
    </>
  );
}

/**
 * What the Tablet shows, above the Skins: the build its Skin reported and
 * since when, that a newer build is installed, and that a new default shows
 * after a restart; or the Skin served, where it does not report its page, or
 * that none is. To an Admin, and to Staff at the Machine's Location, Reload
 * where the Skin served reported its page, and always the restart of the
 * Skin view, behind a confirmation.
 */
function ShowingStrip({
  skins,
  showing,
  acting,
  disabled,
  narrow,
  make,
}: {
  skins: readonly TabletSkin[];
  showing: TabletShowing;
  acting: Acting;
  disabled: boolean;
  narrow: boolean;
  make(action: NewAction): Promise<void>;
}) {
  const served = showing.skin;
  const reported = served !== null && skins.some((skin) => skin.id === served.id && skin.pageReported);
  const defaultSkin = skins.find((skin) => skin.default);
  const title = !served
    ? "The Tablet shows no Skin now."
    : reported && showing.page
      ? `The Tablet is showing ${skinLabel(served)}${showing.page.version ? ` ${showing.page.version}` : ""}, loaded at ${formatTime(showing.page.loadedAt)}.`
      : reported
        ? `The Tablet is showing ${skinLabel(served)}.`
        : `The Tablet is serving ${skinLabel(served)}.`;
  return (
    <Item variant="outline" role="group" aria-label="What the Tablet shows" className="bg-muted/40">
      <ItemContent className="min-w-48">
        <ItemTitle className="line-clamp-none w-auto">
          <span className="inline-flex flex-wrap items-center gap-1.5">
            <span>{title}</span>
            {served && reported && showing.page && (
              <InfoTip label="About what the Tablet shows">
                <p>As the Skin last reported, at {formatTime(showing.page.reportedAt)}, by the Tablet's clock.</p>
              </InfoTip>
            )}
            {served && !reported && (
              <InfoTip label="About what the Tablet shows">
                <p>A Skin that reports its page says which build it loaded and can be asked to reload. This one can be loaded again only by restarting the Skin view.</p>
              </InfoTip>
            )}
            {!served && (
              <InfoTip label="About what the Tablet shows">
                <p>Decaid's Skin server is stopped. Restarting the Skin view starts it on the default Skin.</p>
              </InfoTip>
            )}
          </span>
        </ItemTitle>
        {served && !reported && <ItemDescription className="line-clamp-none">This Skin doesn't report which build it has loaded.</ItemDescription>}
        {served && reported && showing.newerInstalled && served.version && (
          <ItemDescription className="line-clamp-none font-medium text-amber-700 dark:text-amber-500">{served.version} is installed and shows after a reload.</ItemDescription>
        )}
        {showing.nextDefault && (
          <ItemDescription className="line-clamp-none font-medium text-amber-700 dark:text-amber-500">
            {skinLabel(showing.nextDefault)} is the default now, and shows after a restart of the Skin view.
          </ItemDescription>
        )}
      </ItemContent>
      {acting.skinViewOffered && (
        <ItemActions className={narrow ? ITEM_ACTIONS_WHEN_NARROW : "flex-wrap"}>
          {reported && (
            <Button size={narrow ? "default" : "sm"} disabled={disabled} onClick={() => void make({ kind: "reloadSkin" })}>
              Reload
            </Button>
          )}
          <ConfirmButton
            label="Restart the Skin view"
            title="Restart the Skin view?"
            description={
              <>
                The Tablet's screen goes blank for a moment, then loads the default Skin{defaultSkin ? `, ${skinLabel(defaultSkin)}` : ""}. Anything a barista was typing is
                lost. A Skin that hung is loaded again this way.
              </>
            }
            confirmLabel="Restart"
            size={narrow ? undefined : "sm"}
            disabled={disabled}
            onConfirm={() => void make({ kind: "restartSkinView" })}
          />
        </ItemActions>
      )}
    </Item>
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
    case "followsUrl":
      return "follows its URL";
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
function InstallPluginDialog({ machine, disabled, narrow, onMade }: { machine: Machine; disabled: boolean; narrow: boolean; onMade(action: SoftwareAction): void }) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size={narrow ? "default" : "sm"} disabled={disabled}>
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
 * Installing a Skin on the Tablet: from a GitHub repository's latest
 * release, or a branch, which it then follows, or from the URL of a zip,
 * such as a commit's archive, which pins it. The sources the account's other
 * Machines' Skins came from are suggested, and picking one fills the form.
 * Made, the dialog closes and the Skins card follows the action; refused at
 * once, the dialog says why.
 */
function InstallSkinDialog({ machine, disabled, narrow, onMade }: { machine: Machine; disabled: boolean; narrow: boolean; onMade(action: SoftwareAction): void }) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size={narrow ? "default" : "sm"} disabled={disabled}>
          Install Skin
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Install Skin</DialogTitle>
          <DialogDescription>On {machine.name}</DialogDescription>
        </DialogHeader>
        {/* Mounted only while open, so it starts over each time. */}
        {open && (
          <InstallSkinForm
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

type SkinFrom = "release" | "branch" | "url";

function InstallSkinForm({ machine, onCancel, onMade }: { machine: Machine; onCancel(): void; onMade(action: SoftwareAction): void }) {
  const id = useId();
  const [sources, setSources] = useState<SkinSource[]>();
  const [which, setWhich] = useState<SkinFrom>("release");
  const [repo, setRepo] = useState("");
  const [branch, setBranch] = useState("");
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let stopped = false;
    api<{ skinSources: SkinSource[] }>("GET", `/machines/${encodeURIComponent(machine.id)}/skin-sources`).then(
      ({ skinSources }) => !stopped && setSources(skinSources),
      // The suggestions only help: without them the form still installs.
      () => !stopped && setSources([]),
    );
    return () => {
      stopped = true;
    };
  }, [machine.id]);

  function pick(source: SkinSource) {
    if (source.url) {
      setWhich("url");
      setUrl(source.url);
    } else {
      setWhich(source.branch ? "branch" : "release");
      setRepo(source.repo ?? "");
      setBranch(source.branch ?? "");
    }
    setError(undefined);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const named = repo.trim();
    const typed = branch.trim();
    const problems =
      which === "url"
        ? isSkinUrl(url.trim())
          ? []
          : ["Give the URL of a zip to install the Skin from, such as https://github.com/owner/name/archive/<commit>.zip"]
        : [
            ...(isPluginRepo(named) ? [] : ["Give the GitHub repository as owner/name, such as decentespresso/streamline-js"]),
            ...(which === "release" || (typed !== "" && !/\s/.test(typed)) ? [] : ["Give a branch"]),
            // Decaid installs no Skin from a commit named as its branch (#659): its archive's URL pins it.
            ...(which === "branch" && namesCommit(typed) && isPluginRepo(named) ? [`Decaid installs a Skin from a commit only by its archive's URL: https://github.com/${named}/archive/${typed}.zip`] : []),
          ];
    if (problems.length > 0) return setError(problems.join(". "));
    setError(undefined);
    setSaving(true);
    try {
      const action: NewAction = which === "url" ? { kind: "installSkin", url: url.trim() } : { kind: "installSkin", repo: named, ...(which === "branch" ? { branch: typed } : {}) };
      onMade(await makeAction(machine.id, action));
    } catch (caught) {
      setError(failure(caught, "The Skin could not be installed"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form aria-label="Install Skin" className="grid min-w-0 gap-5" noValidate onSubmit={(event) => void submit(event)}>
      {error && <FormError error={error} />}
      {sources && sources.length > 0 && (
        <section aria-label="In use on your other Machines" className="grid gap-2">
          <h3 className="text-sm font-medium">In use on your other Machines</h3>
          <ul className="grid gap-2">
            {sources.map((source) => (
              <li key={`${source.skinId} ${source.repo ?? ""} ${source.branch ?? ""} ${source.url ?? ""}`}>
                <Button type="button" variant="outline" className="h-auto w-full justify-start py-2 text-left whitespace-normal" onClick={() => pick(source)}>
                  <span className="grid min-w-0 gap-0.5">
                    <span className="font-medium">
                      {source.name ?? source.skinId}
                      {source.version ? ` ${source.version}` : ""} · {howShort(source.updates)}
                    </span>
                    <span className="text-xs font-normal wrap-anywhere text-muted-foreground">
                      {skinSourceText(source)} · on {source.machines} {source.machines === 1 ? "Machine" : "Machines"}
                    </span>
                  </span>
                </Button>
              </li>
            ))}
          </ul>
        </section>
      )}
      <FieldGroup className="gap-4">
        <div className="grid gap-2">
          <Label id={`${id}-which`}>Install from</Label>
          <RadioGroup
            aria-labelledby={`${id}-which`}
            value={which}
            onValueChange={(value) => setWhich(value === "branch" || value === "url" ? value : "release")}
            className="flex flex-wrap gap-4"
          >
            {(
              [
                ["release", "Latest release"],
                ["branch", "Branch"],
                ["url", "URL"],
              ] as const
            ).map(([value, label]) => (
              <div key={value} className="flex items-center gap-2">
                <RadioGroupItem id={`${id}-${value}`} value={value} />
                <Label htmlFor={`${id}-${value}`} className="font-normal">
                  {label}
                </Label>
              </div>
            ))}
          </RadioGroup>
        </div>
        {which !== "url" && (
          <FormField>
            <FieldLabel htmlFor={`${id}-repo`}>GitHub repository</FieldLabel>
            <Input id={`${id}-repo`} placeholder="owner/name" autoComplete="off" spellCheck={false} value={repo} onChange={(event) => setRepo(event.target.value)} />
          </FormField>
        )}
        {which === "branch" && (
          <FormField>
            <FieldLabel htmlFor={`${id}-branch-name`}>Branch</FieldLabel>
            <Input id={`${id}-branch-name`} autoComplete="off" spellCheck={false} value={branch} onChange={(event) => setBranch(event.target.value)} />
            <FieldDescription>It follows the branch's newest commit. To pin a commit, install its archive's URL.</FieldDescription>
          </FormField>
        )}
        {which === "url" && (
          <FormField>
            <FieldLabel htmlFor={`${id}-url-address`}>URL</FieldLabel>
            <Input
              id={`${id}-url-address`}
              type="url"
              placeholder="https://github.com/owner/name/archive/<commit>.zip"
              autoComplete="off"
              spellCheck={false}
              value={url}
              onChange={(event) => setUrl(event.target.value)}
            />
            <FieldDescription>A zip of the Skin. A commit's archive stays pinned.</FieldDescription>
          </FormField>
        )}
      </FieldGroup>
      <p className="text-sm text-muted-foreground">A Skin newly installed is not the default: its row then offers Make default.</p>
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
function PluginSettingsDialog({
  machine,
  plugin,
  disabled,
  onMade,
  onOpened,
  opened,
}: {
  machine: Machine;
  plugin: TabletPlugin;
  disabled: boolean;
  onMade(action: SoftwareAction): void;
  /** Told as it opens, and as it closes or goes. */
  onOpened(open: boolean): void;
  /** Where a row's menu opens it, its state there, and no button of its own. */
  opened?: { open: boolean; onOpenChange(open: boolean): void; onCloseAutoFocus(event: Event): void };
}) {
  const [own, setOwn] = useState(false);
  const open = opened ? opened.open : own;
  const setOpen = opened ? opened.onOpenChange : setOwn;
  useEffect(() => {
    if (!open) return;
    onOpened(true);
    return () => onOpened(false);
  }, [open, onOpened]);
  const title = `${pluginLabel(plugin)} settings`;
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {!opened && (
        <DialogTrigger asChild>
          <Button variant="outline" size="sm" aria-label={title} disabled={disabled}>
            Settings
          </Button>
        </DialogTrigger>
      )}
      <DialogContent
        className="max-h-[90dvh] overflow-y-auto sm:max-w-lg"
        onCloseAutoFocus={opened?.onCloseAutoFocus}
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
