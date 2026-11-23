import { useCallback, useEffect, useRef, useState } from "react";
import { CollapsibleCard } from "@/components/collapsible-card";
import { InfoTip } from "@/components/info-tip";
import { failure } from "@/components/library-forms";
import { formatTime } from "@/components/machines";
import { ScrollsSideways } from "@/components/scrolls-sideways";
import { MadeBy } from "@/components/settings-edits";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { type SoftwareAction, type SoftwareActionPage, type TabletPlugin, api } from "@/lib/api";
import { DETAILS_POLL_MS, usePolled, useReloadOn } from "@/lib/use-polled";
import { nameDecaidState, namesCommit } from "@decent-sync/protocol";

// Software Actions (ADR-0034): what an Admin asked a Machine's Tablet to do
// to its plugins and to Decaid, worded as the Software tab's log and status
// say it, the status of one just made followed until it has an outcome, and
// the log of them all.

/** How often an action awaiting its answer is read again. */
const PENDING_POLL_MS = 1_000;

/** How often one not confirmed is read again, as an answer may still arrive late, and may never. */
const NOT_CONFIRMED_POLL_MS = 5_000;

const PAGE_SIZE = 20;

/** The Tablet's plugins as last reported, which name what an action named only by its id. */
type Plugins = readonly TabletPlugin[] | null | undefined;

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

/**
 * What an action did, as the log says it, in the past tense whatever came of
 * it: "Installed the plugin DYE2 · decentespresso/dye2 at 717fa95",
 * "Changed Visualizer's settings · Username, Password". A plugin is named as
 * the Tablet reported it, the settings by their labels where it still
 * declares them.
 */
export function actionText(action: SoftwareAction, plugins?: Plugins): string {
  const { params } = action;
  const plugin = pluginName(params.plugin?.id ?? action.result?.pluginId, params.plugin?.name, plugins);
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
    case "checkDecaidUpdate":
      return "Checked for Decaid's update";
    default:
      return "A Software Action of a later release";
  }
}

/** What Decaid's own update state says, as the Decaid card and an update check's outcome word it. */
export function decaidUpdateText(update: { phase?: unknown; latestVersion?: unknown; error?: unknown }): string {
  const latest = typeof update.latestVersion === "string" && update.latestVersion !== "" ? update.latestVersion : null;
  if (typeof update.error === "string" && update.error !== "") return `The check failed: ${update.error}`;
  switch (update.phase) {
    case "checking":
      return "Checking";
    case "downloading":
      return latest ? `Downloading ${latest}` : "Downloading";
    case "installing":
      return latest ? `Installing ${latest}` : "Installing";
    case "error":
      return "The check failed";
  }
  return latest ? `${latest} is available` : "Up to date";
}

/** An update check's result for each plugin, short: "DYE2 updated to 0.1.43, 2 already current, Shot upload waits for approval". */
function updateCheckText(results: NonNullable<NonNullable<SoftwareAction["result"]>["results"]>, plugins: Plugins): string {
  if (results.length === 0) return "No plugin to check";
  const named = (id: string) => pluginName(id, null, plugins).replace(/^a plugin$/, "A plugin no longer listed");
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

/**
 * What came of an action, short, as the log says it: "Done · 0.1.42",
 * "Refused: the Machine was pulling a shot", "Refused by Decaid: ...", "Not
 * confirmed", or "Waiting for the Tablet…" while it awaits its answer.
 */
export function outcomeText(action: SoftwareAction, plugins?: Plugins): string {
  const late = action.late ? ", answered late" : "";
  switch (action.outcome) {
    case null:
      return "Waiting for the Tablet…";
    case "notConfirmed":
      return "Not confirmed";
    case "done": {
      const result = action.result;
      if (action.kind === "checkPluginUpdates" && result?.results) return `Done${late} · ${updateCheckText(result.results, plugins)}`;
      if (action.kind === "checkDecaidUpdate" && result?.decaid) return `Done${late} · ${decaidUpdateText(result.decaid)}`;
      if ((action.kind === "installPlugin" || action.kind === "approvePluginUpdate") && result?.version) return `Done${late} · ${result.version}`;
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
      return refusal.message ? `Refused: ${refusal.message}` : "Refused";
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
  if (action.outcome === "notConfirmed") {
    return "The Tablet didn't answer in time, or its connection closed first. Check the lists before trying again: it may have been done all the same.";
  }
  if (action.outcome === "refused" && action.refusal?.reason === "expired") return "The Tablet got it too late to start it, so nothing was done.";
  if (action.late) return "The Tablet answered after the action was marked not confirmed.";
  return undefined;
}

/** An outcome with what explains it in a tooltip, as the log shows it. */
export function SoftwareActionOutcome({ action, plugins }: { action: SoftwareAction; plugins?: Plugins }) {
  const about = outcomeAbout(action);
  return (
    <span className="inline-flex items-center gap-1.5">
      <span>{outcomeText(action, plugins)}</span>
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
  onAnswered,
}: {
  machineId: string;
  action: SoftwareAction;
  plugins: Plugins;
  onAnswered(): Promise<void> | void;
}) {
  const [action, setAction] = useState(made);
  const [error, setError] = useState<string>();
  const outcome = action.outcome;
  const awaiting = outcome === null || (outcome === "notConfirmed" && action.answeredAt === null);
  const answered = useRef(onAnswered);
  answered.current = onAnswered;
  // Named by the plugins as they stood when it was made, as a removed one is gone from them once it is answered.
  const [named] = useState(plugins);

  useEffect(() => {
    if (made.outcome !== null && made.outcome !== "notConfirmed") void answered.current();
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
          if (softwareAction.outcome !== null && softwareAction.outcome !== "notConfirmed") await answered.current();
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

  const what = actionText(action, plugins ?? named);
  const about = outcomeAbout(action);
  const [title, description] =
    outcome === null
      ? ["Waiting for the Tablet…", `${what}. Sent to the Tablet, waiting for its answer.`]
      : outcome === "notConfirmed"
        ? ["Not confirmed", `${what}. Check the lists before trying again.`]
        : [outcome === "done" ? "Done" : "Refused", `${what}. ${sentence(outcomeText(action, plugins ?? named))}`];
  return (
    <Alert role="status" variant={outcome === "refused" || outcome === "notConfirmed" ? "destructive" : "default"}>
      <AlertTitle className="flex items-center gap-1.5">
        {title}
        {about && <InfoTip label="About this outcome">{about}</InfoTip>}
      </AlertTitle>
      <AlertDescription>
        {description}
        {error && ` ${error}.`}
      </AlertDescription>
    </Alert>
  );
}

/**
 * The Machine's Software Actions, newest first, a page at a time: when each
 * was made, what it did, who made it and what came of it. Shown closed until
 * opened, as most who read the tab do not need it, and loaded again
 * whenever `answered` changes, as an action made on the tab is answered.
 */
export function SoftwareActionsCard({ machineId, plugins, answered }: { machineId: string; plugins: Plugins; answered: number }) {
  return (
    <CollapsibleCard
      title="Software Actions"
      info={
        <>
          <p>
            Each thing an Admin asked the Tablet to do to its plugins or to Decaid from here or through a Connected App, newest first, with who
            asked and what came of it. Each is made once, only while the Tablet is connected, and never kept for later.
          </p>
          <p>The changes each made are listed in the Settings History too, tied to it.</p>
        </>
      }
    >
      <SoftwareActionsLog machineId={machineId} plugins={plugins} answered={answered} />
    </CollapsibleCard>
  );
}

function SoftwareActionsLog({ machineId, plugins, answered }: { machineId: string; plugins: Plugins; answered: number }) {
  const [offset, setOffset] = useState(0);
  const load = useCallback(async () => {
    const query = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) });
    return { offset, page: await api<SoftwareActionPage>("GET", `/machines/${encodeURIComponent(machineId)}/software-actions?${query}`) };
  }, [machineId, offset]);
  const { data, error, reload } = usePolled(load, DETAILS_POLL_MS);
  useReloadOn(answered, reload);
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
      {data && data.page.softwareActions.length > 0 && <ScrollsSideways />}
      {data && data.page.softwareActions.length > 0 && (
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
                <TableCell className="min-w-48 align-top whitespace-normal">{actionText(action, plugins)}</TableCell>
                <TableCell className="min-w-28 align-top whitespace-normal">
                  <SoftwareActionMadeBy action={action} />
                </TableCell>
                <TableCell className="min-w-40 align-top whitespace-normal">
                  <SoftwareActionOutcome action={action} plugins={plugins} />
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
            <Button variant="outline" size="sm" disabled={data.offset === 0} onClick={() => setOffset(Math.max(0, data.offset - PAGE_SIZE))}>
              Newer
            </Button>
            <Button variant="outline" size="sm" disabled={last >= data.page.total} onClick={() => setOffset(data.offset + PAGE_SIZE)}>
              Older
            </Button>
          </div>
        </div>
      )}
    </CardContent>
  );
}
