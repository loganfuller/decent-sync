import { useCallback, useEffect, useRef, useState } from "react";
import { CollapsibleCard } from "@/components/collapsible-card";
import { InfoTip } from "@/components/info-tip";
import { failure } from "@/components/library-forms";
import { formatTime } from "@/components/machines";
import { MadeBy } from "@/components/settings-edits";
import { type Lasting, StatusAlert } from "@/components/status-alert";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { type SoftwareAction, type SoftwareActionPage, type TabletPlugin, type TabletSkin, api } from "@/lib/api";
import { DETAILS_POLL_MS, usePolled, useReloadOn } from "@/lib/use-polled";
import { useNarrowScreen } from "@/lib/use-screen";
import { nameDecaidState, namesCommit, releaseAssetOf } from "@decent-sync/protocol";

// Software Actions (ADR-0034): what an Admin asked a Machine's Tablet to do
// to its plugins, its Skins and Decaid, and Staff at its Location to its
// Skin view (#661), worded as the Software tab's log and status say it, the
// status of one just made followed until it has an outcome, and the log of
// them all.

/** How often an action awaiting its answer is read again. */
const PENDING_POLL_MS = 1_000;

/** How often one not confirmed is read again, as an answer may still arrive late, and may never. */
const NOT_CONFIRMED_POLL_MS = 5_000;

const PAGE_SIZE = 20;

/** The Tablet's plugins as last reported, which name what an action named only by its id. */
type Plugins = readonly TabletPlugin[] | null | undefined;

/** The Tablet's Skins as last reported, which name what an update check names only by its id or repository. */
type Skins = readonly TabletSkin[] | null | undefined;

/** A plugin by the name the Tablet reported for it when the action was made, or now, or else as "a plugin". */
function pluginName(id: string | undefined, named: string | null | undefined, plugins: Plugins): string {
  if (named) return named;
  const now = id === undefined ? undefined : plugins?.find((plugin) => plugin.id === id);
  return now?.name ?? "a plugin";
}

/** Where a plugin is installed from as an install names it: its repository, then a commit it is pinned at or a branch it follows. */
export function sourceText(repo: string, branch: string | null | undefined): string {
  if (!branch) return repo;
  return namesCommit(branch) ? `${repo} at ${branch.slice(0, 7)}` : `${repo}, ${branch}`;
}

/** A Skin by the name the Tablet reported for it when the action was made, or as done, or now, or else by its id. */
function skinName(id: string | undefined, named: string | null | undefined, skins: Skins): string | null {
  if (named) return named;
  const now = id === undefined ? undefined : skins?.find((skin) => skin.id === id);
  return now?.name ?? id ?? null;
}

/**
 * Where a Skin is installed from as an install names it: its repository, with
 * a branch it follows, or its URL, a GitHub commit's archive or one release's
 * download shortened to its repository and the commit or tag.
 */
export function skinSourceText(source: { repo?: string | null; branch?: string | null; url?: string | null }): string {
  if (source.url) {
    const archive = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/archive\/([0-9a-f]{40})\.zip$/i.exec(source.url);
    if (archive) return `${archive[1]} at ${archive[2]!.slice(0, 7)}`;
    const asset = releaseAssetOf(source.url);
    return asset ? `${asset.repo} at ${asset.tag}` : source.url;
  }
  return source.repo ? sourceText(source.repo, source.branch) : "";
}

/**
 * The source a change of how an item updates named, as the log says how it
 * updates from then on: "follows releases of decentespresso/dye2", "follows
 * decentespresso/dye2, dist", "pinned to decentespresso/dye2 at 717fa95".
 */
function newSourceText(source: { repo?: string | null; branch?: string | null; url?: string | null }): string {
  if (source.url) {
    const from = skinSourceText(source);
    // A commit's archive or one release's download holds it there; any other URL is followed.
    return from === source.url ? `follows ${from}` : `pinned to ${from}`;
  }
  if (!source.repo) return "";
  if (!source.branch) return `follows releases of ${source.repo}`;
  return namesCommit(source.branch) ? `pinned to ${sourceText(source.repo, source.branch)}` : `follows ${sourceText(source.repo, source.branch)}`;
}

/**
 * What an action did, as the log says it, in the past tense whatever came of
 * it: "Installed the plugin DYE2 · decentespresso/dye2 at 717fa95",
 * "Changed Visualizer's settings · Username, Password", "Made Streamline
 * Cafe the default Skin". A plugin or Skin is named as the Tablet reported
 * it, the settings by their labels where it still declares them.
 */
export function actionText(action: SoftwareAction, plugins?: Plugins, skins?: Skins): string {
  const { params } = action;
  const plugin = pluginName(params.plugin?.id ?? action.result?.pluginId, params.plugin?.name, plugins);
  const skin = skinName(params.skin?.id ?? action.result?.skinId, params.skin?.name ?? action.result?.name, skins);
  switch (action.kind) {
    case "installPlugin": {
      const installed = action.result?.pluginId ? pluginName(action.result.pluginId, action.result.name, plugins) : "a plugin";
      const what = installed === "a plugin" ? "Installed a plugin" : `Installed the plugin ${installed}`;
      return params.repo ? `${what} · ${sourceText(params.repo, params.branch)}` : what;
    }
    case "enablePlugin":
      return `Enabled ${plugin}`;
    case "disablePlugin":
      return `Disabled ${plugin}`;
    case "removePlugin":
      return `Removed ${plugin}`;
    case "approvePluginUpdate":
      return `Approved ${plugin}'s update${params.version ? ` to ${params.version}` : ""}`;
    case "changePluginSettings": {
      const declared = plugins?.find((entry) => entry.id === params.plugin?.id)?.settings ?? [];
      // In the order the plugin declares them, as the server keeps them in another.
      const place = (name: string) => {
        const index = declared.findIndex((setting) => setting.name === name);
        return index === -1 ? declared.length : index;
      };
      const labels = [...(params.settings ?? [])].sort((a, b) => place(a) - place(b)).map((name) => declared.find((setting) => setting.name === name)?.label ?? name);
      return `Changed ${plugin}'s settings${labels.length > 0 ? ` · ${labels.join(", ")}` : ""}`;
    }
    case "checkPluginUpdates":
      return "Checked plugins for updates";
    case "changePluginSource":
      return `Changed how ${plugin} updates${params.repo ? ` · ${newSourceText(params)}` : ""}`;
    case "changeSkinSource":
      return `Changed how ${skin ?? "a Skin"} updates${params.repo || params.url ? ` · ${newSourceText(params)}` : ""}`;
    case "installSkin": {
      const installed = action.result?.skinId ? skinName(action.result.skinId, action.result.name, skins) : null;
      const what = installed ? `Installed the Skin ${installed}` : "Installed a Skin";
      const from = skinSourceText(params);
      return from ? `${what} · ${from}` : what;
    }
    case "chooseDefaultSkin":
      return skin ? `Made ${skin} the default Skin` : "Chose the default Skin";
    case "removeSkin":
      return skin ? `Removed the Skin ${skin}` : "Removed a Skin";
    case "checkSkinUpdates":
      return "Checked Skins for updates";
    case "reloadSkin":
      return skin ? `Reloaded the Skin ${skin}` : "Reloaded the Skin";
    case "restartSkinView":
      return "Restarted the Skin view";
    case "checkDecaidUpdate":
      return "Checked for Decaid's update";
    case "startDecaidUpdate":
      return `Started Decaid's update${params.version ? ` to ${params.version}` : ""} on the Tablet`;
    default:
      return "A Software Action of a later release";
  }
}

/** What Decaid's own update state says, as the Decaid card and an update check's outcome word it. */
export function decaidUpdateText(update: { phase?: unknown; latestVersion?: unknown; error?: unknown }): string {
  const latest = typeof update.latestVersion === "string" && update.latestVersion !== "" ? update.latestVersion : null;
  // A failed check, download or install alike, in Decaid's words, which say which ("Couldn't download the app update. ...").
  if (typeof update.error === "string" && update.error !== "") return update.error;
  switch (update.phase) {
    case "checking":
      return "Checking";
    case "downloading":
      return latest ? `Downloading ${latest}` : "Downloading";
    case "installing":
      return latest ? `Installing ${latest}` : "Installing";
    case "error":
      return "Decaid's last check or update failed";
  }
  return latest ? `${latest} is available` : "Up to date";
}

/**
 * An update check's result for each plugin or Skin, short: "DYE2 updated to
 * 0.1.43, 2 already current, Shot upload waits for approval". A Skin is
 * named by matching its id, or for one that comes with Decaid, which the
 * check names by its repository, the repository it updates from.
 */
function updateCheckText(results: NonNullable<NonNullable<SoftwareAction["result"]>["results"]>, named: (item: string) => string, nothing: string): string {
  if (results.length === 0) return nothing;
  const current = results.filter((result) => result.status === "alreadyCurrent").length;
  const parts = [
    ...results.filter((result) => result.status === "updated").map((result) => `${named(result.item)} updated${result.version ? ` to ${result.version}` : ""}`),
    ...(current > 0 ? [`${current} already current`] : []),
    ...results.filter((result) => result.status === "pendingApproval").map((result) => `${named(result.item)} waits for approval`),
    ...results.filter((result) => result.status === "failed").map((result) => `${named(result.item)} failed${result.error ? `: ${result.error}` : ""}`),
    ...results.filter((result) => !["updated", "alreadyCurrent", "pendingApproval", "failed"].includes(result.status)).map((result) => `${named(result.item)}: ${result.status}`),
  ];
  return parts.join(", ");
}

/** A plugin an update check names by its id, by its name. */
function pluginCheckedName(plugins: Plugins): (item: string) => string {
  return (id) => pluginName(id, null, plugins).replace(/^a plugin$/, "A plugin no longer listed");
}

/** A Skin an update check names by its id, or by the repository of one that comes with Decaid, by its name. */
function skinCheckedName(skins: Skins): (item: string) => string {
  return (item) => {
    const repo = item.toLowerCase();
    // Only one that comes with Decaid is named by its repository: another from that repository, such as one Pinned at a release's tag, is named by its id.
    const skin = skins?.find((entry) => entry.id === item) ?? skins?.find((entry) => entry.updates.how === "comesWithDecaid" && entry.updates.repo?.toLowerCase() === repo);
    return skin?.name ?? skin?.id ?? item;
  };
}

/**
 * What came of an action, short, as the log says it: "Done · 0.1.42",
 * "Refused: the Machine was pulling a shot", "Refused by Decaid: ...", "Not
 * confirmed", with what did not show where the plugin said, or "Waiting for
 * the Tablet…" while it awaits its answer.
 */
export function outcomeText(action: SoftwareAction, plugins?: Plugins, skins?: Skins): string {
  const late = action.late ? ", answered late" : "";
  switch (action.outcome) {
    case null:
      return "Waiting for the Tablet…";
    case "notConfirmed":
      return action.note ? `Not confirmed · ${action.note}` : "Not confirmed";
    case "done": {
      const result = action.result;
      if (action.kind === "checkPluginUpdates" && result?.results) return `Done${late} · ${updateCheckText(result.results, pluginCheckedName(plugins), "No plugin to check")}`;
      if (action.kind === "checkSkinUpdates" && result?.results) return `Done${late} · ${updateCheckText(result.results, skinCheckedName(skins), "No Skin to check")}`;
      if ((action.kind === "checkDecaidUpdate" || action.kind === "startDecaidUpdate") && result?.decaid) return `Done${late} · ${decaidUpdateText(result.decaid)}`;
      if ((action.kind === "installPlugin" || action.kind === "approvePluginUpdate" || action.kind === "installSkin") && result?.version) return `Done${late} · ${result.version}`;
      if ((action.kind === "changePluginSource" || action.kind === "changeSkinSource") && result?.version) {
        // Its version before and after, as the new source may serve another; and the permissions a plugin's new build adds.
        const versions = result.previousVersion && result.previousVersion !== result.version ? `${result.previousVersion} → ${result.version}` : result.version;
        const added = result.addedPermissions?.length ? ` · adds ${result.addedPermissions.length === 1 ? "the permission" : "the permissions"} ${result.addedPermissions.join(", ")}` : "";
        return `Done${late} · ${versions}${added}`;
      }
      if (action.kind === "reloadSkin" && (result?.page?.version ?? result?.version)) return `Done${late} · showing ${result?.page?.version ?? result?.version}`;
      if (action.kind === "restartSkinView" && (result?.name ?? result?.skinId)) {
        return `Done${late} · showing ${result?.name ?? result?.skinId}${result?.version ? ` ${result.version}` : ""}`;
      }
      return `Done${late}`;
    }
    case "refused":
      return `${refusalText(action)}${late}`;
  }
}

/** Why an action was refused, in the words of what refused it where it gave them. */
function refusalText(action: SoftwareAction): string {
  const refusal = action.refusal;
  switch (refusal?.reason) {
    case "machineBusy":
      return refusal.state ? `Refused: the Machine was ${nameDecaidState(refusal.state).toLowerCase()}` : "Refused: the Machine was busy";
    case "expired":
      return "Refused: expired";
    case "changedSince":
    case "notAllowed":
    case "differentItem":
      return refusal.message ? `Refused: ${refusal.message}` : "Refused";
    case "installNotPermitted":
      return (
        "Refused: Android's permission for Decaid to install apps has not been granted on the Tablet. Someone there must allow it " +
        "(Android settings, Apps, Decaid, Install unknown apps), or start the update on Decaid's own screen"
      );
    case "noSkinServed":
      return "The Skin view did not start again, so the Tablet shows no Skin now: restart it again, or reopen Decaid at the Tablet";
    case "decaid":
      if (refusal.status === null) return `Refused: ${refusal.message ?? "Decaid did not answer"}`;
      return `Refused by Decaid: ${refusal.message ?? `no reason given (${refusal.status})`}`;
    default:
      return "Refused";
  }
}

/** Text ended as a sentence, as words quoted from Decaid may already be. */
function sentence(text: string): string {
  return /[.!?…]$/.test(text) ? text : `${text}.`;
}

/** What explains an outcome, for a tooltip beside it, where it needs explaining. */
function outcomeAbout(action: SoftwareAction): string | undefined {
  if (action.outcome === "notConfirmed" && action.note) {
    return action.kind === "reloadSkin"
      ? "The Tablet asked the Skin to load its page again, but no fresh page reported in. A Skin that hung reloads only when the Skin view restarts."
      : "The Tablet carried it out, but what came of it never showed. Check the lists before trying again.";
  }
  if (action.outcome === "notConfirmed") {
    return "The Tablet didn't answer in time, or its connection closed first. Check the lists before trying again: it may have been done all the same.";
  }
  if (action.outcome === "refused" && action.refusal?.reason === "expired") return "The Tablet got it too late to start it, so nothing was done.";
  if (action.outcome === "refused" && action.refusal?.reason === "installNotPermitted" && action.refusal.message) return `Decaid said: ${sentence(action.refusal.message)}`;
  if (action.outcome === "refused" && action.refusal?.reason === "noSkinServed" && action.refusal.message) return sentence(action.refusal.message);
  if (action.late) return "The Tablet answered after the action was marked not confirmed.";
  return undefined;
}

/** What an action's status says after its outcome, for those whose outcome leaves something to do or to know. */
function afterword(action: SoftwareAction): string | null {
  if (action.outcome === "done" && action.kind === "chooseDefaultSkin") return "It shows once the Skin view restarts.";
  if (action.outcome === "done" && action.kind === "startDecaidUpdate") {
    return "Someone at the Tablet must now confirm the update in Android's installer, then tap Open: Decaid does not reopen by itself.";
  }
  if (action.outcome === "notConfirmed" && action.kind === "reloadSkin") return "Restart the Skin view to load it again.";
  if (action.outcome === "done" && action.kind === "changePluginSource" && action.result?.addedPermissions?.length) {
    return "Its new build holds what it adds with no approval asked, as Decaid asks for none when a plugin is installed again.";
  }
  // Decaid's 409 for a plugin's install is its refusal of a build older than the one installed.
  if (action.outcome === "refused" && action.kind === "changePluginSource" && action.refusal?.reason === "decaid" && action.refusal.status === 409) {
    return "Decaid installs no build older than the one installed. Removing the plugin first would delete its settings, so nothing was changed.";
  }
  return null;
}

/**
 * Whether a done action says something in it failed, or may have: an update
 * check with a plugin or Skin that failed, or answered with what this release
 * doesn't know, or Decaid's own update state saying it failed, as
 * `decaidUpdateText` words it.
 */
function failedWithin(action: SoftwareAction): boolean {
  const result = action.result;
  if (result?.results?.some((entry) => !["updated", "alreadyCurrent", "pendingApproval"].includes(entry.status))) return true;
  const decaid = result?.decaid;
  return decaid !== undefined && ((typeof decaid.error === "string" && decaid.error !== "") || decaid.phase === "error");
}

/** An outcome with what explains it in a tooltip, as the log shows it. */
export function SoftwareActionOutcome({ action, plugins, skins }: { action: SoftwareAction; plugins?: Plugins; skins?: Skins }) {
  const about = outcomeAbout(action);
  return (
    <span className="inline-flex items-center gap-1.5">
      <span>{outcomeText(action, plugins, skins)}</span>
      {about && <InfoTip label="About this outcome">{about}</InfoTip>}
    </span>
  );
}

/** Who made an action, as the Settings History names who made an edit, "through" the Connected App it was made through. */
export function SoftwareActionMadeBy({ action }: { action: SoftwareAction }) {
  return <MadeBy account={action.account} connectedApp={action.connectedApp} />;
}

/**
 * The latest action made from one place on the tab: waiting for the Tablet,
 * read again until it is answered, then what came of it, shown in place.
 * One not confirmed is read again, less often, until an answer arriving late
 * replaces the mark. Once it is answered, whether as it is read again or
 * already as it was made, `onAnswered` reloads the lists and the log, whose
 * read-back the server took in before the answer.
 */
export function SoftwareActionStatus({
  machineId,
  action: made,
  plugins,
  skins,
  onAnswered,
}: {
  machineId: string;
  action: SoftwareAction;
  plugins: Plugins;
  skins?: Skins;
  onAnswered(): Promise<void> | void;
}) {
  const [action, setAction] = useState(made);
  const [error, setError] = useState<string>();
  const outcome = action.outcome;
  const awaiting = outcome === null || (outcome === "notConfirmed" && action.answeredAt === null);
  const answered = useRef(onAnswered);
  answered.current = onAnswered;
  // Named by the plugins and Skins as they stood when it was made, as a removed one is gone from them once it is answered.
  const [named] = useState(plugins);
  const [namedSkins] = useState(skins);

  useEffect(() => {
    if (isAnswered(made)) void answered.current();
  }, [made]);

  useEffect(() => {
    if (!awaiting) return;
    let stopped = false;
    const timer = setInterval(
      async () => {
        try {
          const { softwareAction } = await api<{ softwareAction: SoftwareAction }>("GET", `/machines/${encodeURIComponent(machineId)}/software-actions/${encodeURIComponent(made.id)}`);
          if (stopped) return;
          setError(undefined);
          if (softwareAction.outcome === outcome && softwareAction.answeredAt === null) return;
          stopped = true;
          clearInterval(timer);
          setAction(softwareAction);
          if (isAnswered(softwareAction)) await answered.current();
        } catch (caught) {
          if (!stopped) setError(failure(caught, "The action could not be read"));
        }
      },
      outcome === null ? PENDING_POLL_MS : NOT_CONFIRMED_POLL_MS,
    );
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [awaiting, outcome, machineId, made.id]);

  const what = actionText(action, plugins ?? named, skins ?? namedSkins);
  const about = outcomeAbout(action);
  const after = afterword(action);
  const [title, description] =
    outcome === null
      ? ["Waiting for the Tablet…", `${what}. Sent to the Tablet, waiting for its answer.`]
      : outcome === "notConfirmed"
        ? ["Not confirmed", `${what}. ${action.note ? sentence(action.note) : "Check the lists before trying again."}${after ? ` ${after}` : ""}`]
        : [
            outcome === "done" ? "Done" : action.refusal?.reason === "noSkinServed" ? "No Skin shown" : "Refused",
            `${what}. ${sentence(outcomeText(action, plugins ?? named, skins ?? namedSkins))}${after ? ` ${after}` : ""}`,
          ];
  // Only a plain Done goes by itself: one answered late, leaving something to do or saying something in it failed stays to
  // be read, as what went wrong does.
  const lasting: Lasting = outcome === null ? "pending" : outcome === "done" && !action.late && after === null && !failedWithin(action) ? "passing" : "staying";
  return (
    <StatusAlert
      lasting={lasting}
      shows={`${title}: ${description}`}
      variant={outcome === "refused" || outcome === "notConfirmed" ? "destructive" : "default"}
    >
      <AlertTitle className="flex items-center gap-1.5">
        {title}
        {about && <InfoTip label="About this outcome">{about}</InfoTip>}
      </AlertTitle>
      <AlertDescription>
        {description}
        {error && ` ${error}.`}
      </AlertDescription>
    </StatusAlert>
  );
}

/** Whether an action has its answer from the Tablet: done, refused, or not confirmed as the plugin answered it, rather than as no answer came. */
function isAnswered(action: SoftwareAction): boolean {
  return action.outcome !== null && (action.outcome !== "notConfirmed" || action.answeredAt !== null);
}

/**
 * The Machine's Software Actions, newest first, a page at a time: when each
 * was made, what it did, who made it and what came of it. Shown closed until
 * opened, as most who read the tab do not need it, and loaded again
 * whenever `answered` changes, as an action made on the tab is answered.
 */
export function SoftwareActionsCard({ machineId, plugins, skins, answered }: { machineId: string; plugins: Plugins; skins?: Skins; answered: number }) {
  const narrow = useNarrowScreen();
  return (
    <CollapsibleCard
      title="Software Actions"
      buttonSize={narrow ? "default" : "sm"}
      info={
        <>
          <p>
            Each thing an Admin asked the Tablet to do to its plugins, its Skins or Decaid, and each reload or restart of its Skin view Staff at
            its Location asked for, from here or through a Connected App, newest first, with who asked and what came of it. Each is made once,
            only while the Tablet is connected, and never kept for later.
          </p>
          <p>The changes each made are listed in the Settings History too, tied to it.</p>
        </>
      }
    >
      <SoftwareActionsLog machineId={machineId} plugins={plugins} skins={skins} answered={answered} />
    </CollapsibleCard>
  );
}

function SoftwareActionsLog({ machineId, plugins, skins, answered }: { machineId: string; plugins: Plugins; skins: Skins; answered: number }) {
  const [offset, setOffset] = useState(0);
  const load = useCallback(async () => {
    const query = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) });
    return { offset, page: await api<SoftwareActionPage>("GET", `/machines/${encodeURIComponent(machineId)}/software-actions?${query}`) };
  }, [machineId, offset]);
  const { data, error, reload } = usePolled(load, DETAILS_POLL_MS);
  useReloadOn(answered, reload);
  const narrow = useNarrowScreen();
  const first = data ? data.offset + 1 : 0;
  const last = data ? data.offset + data.page.softwareActions.length : 0;
  return (
    <CardContent className="grid gap-3">
      {!data && !error && <p className="text-sm text-muted-foreground">Loading</p>}
      {data?.page.total === 0 && <p className="text-sm text-muted-foreground">No Software Action has been made yet.</p>}
      {error && (
        <Alert variant="destructive">
          <AlertDescription>Could not read the Software Actions: {error}</AlertDescription>
        </Alert>
      )}
      {data && data.page.softwareActions.length > 0 && narrow && (
        // On a narrow screen (#674), a list: what each did, what came of it, then when it was made and who made it.
        <ul aria-label="Software Actions" className="divide-y rounded-lg border">
          {data.page.softwareActions.map((action) => (
            <li key={action.id} className="grid justify-items-start gap-1 px-3 py-2.5 wrap-anywhere">
              <span className="font-medium">{actionText(action, plugins, skins)}</span>
              <SoftwareActionOutcome action={action} plugins={plugins} skins={skins} />
              <span className="text-muted-foreground">
                {formatTime(action.madeAt)} · <SoftwareActionMadeBy action={action} />
              </span>
            </li>
          ))}
        </ul>
      )}
      {data && data.page.softwareActions.length > 0 && !narrow && (
        <Table aria-label="Software Actions">
          <TableHeader>
            <TableRow>
              <TableHead>When</TableHead>
              <TableHead>Action</TableHead>
              <TableHead>Made by</TableHead>
              <TableHead>Outcome</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.page.softwareActions.map((action) => (
              <TableRow key={action.id}>
                <TableCell className="align-top">{formatTime(action.madeAt)}</TableCell>
                <TableCell className="min-w-48 align-top whitespace-normal">{actionText(action, plugins, skins)}</TableCell>
                <TableCell className="min-w-28 align-top whitespace-normal">
                  <SoftwareActionMadeBy action={action} />
                </TableCell>
                <TableCell className="min-w-40 align-top whitespace-normal">
                  <SoftwareActionOutcome action={action} plugins={plugins} skins={skins} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {data && data.page.total > PAGE_SIZE && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm text-muted-foreground" aria-live="polite">
            {first}–{last} of {data.page.total}
          </p>
          <div className="flex gap-2">
            <Button variant="outline" size={narrow ? "default" : "sm"} disabled={data.offset === 0} onClick={() => setOffset(Math.max(0, data.offset - PAGE_SIZE))}>
              Newer
            </Button>
            <Button variant="outline" size={narrow ? "default" : "sm"} disabled={last >= data.page.total} onClick={() => setOffset(data.offset + PAGE_SIZE)}>
              Older
            </Button>
          </div>
        </div>
      )}
    </CardContent>
  );
}
