import { type ReactNode, memo, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import { machineStateOf } from "@decent-sync/protocol";
import { Curves } from "@/components/curves";
import { InfoTip } from "@/components/info-tip";
import { describeMachineState, formatTime } from "@/components/machines";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { api, type Machine, type SteamRecordPage } from "@/lib/api";
import { SHOT_CURVES, profileStep } from "@/lib/curves";
import { type LiveCurve, type LiveCurves, type LiveSteamCurve, liveSamples, liveSteamCurves, withCurvesFrame, withStreamGap } from "@/lib/live-curves";
import {
  STALE_AFTER_MS,
  type LiveCondition,
  type LiveState,
  liveConditionOf,
  machineConnectedOf,
  milkTemperatureOf,
  readLiveEvent,
  reported,
  scaleOf,
  staleAtOf,
  timeInState,
  waterLevelOf,
  withLiveFrame,
} from "@/lib/live-view";
import { STATUS_POLL_MS } from "@/lib/use-polled";
import { cn } from "@/lib/utils";

/** How long after the browser gives up on the stream, as on a refusal, the card opens it again. */
const REOPEN_MS = 5_000;

/**
 * The Machine's Live View (ADR-0024): what it is doing and measuring now, as
 * its Tablet streams it through the server while this page is open, and the
 * curves of its latest shot or steaming. Nothing of it is stored. `machine`
 * is the Machine as the page last polled it, and `profile` the profile of its
 * Workflow, if known, which names a shot's steps.
 *
 * With nothing live to show, the card shrinks to one line saying why: the
 * Machine is offline, its connection reports other hardware, nothing has come
 * yet, or its Tablet isn't connected to it. Values with no machine frame for
 * more than 5 s are dimmed, but for a Machine that said it was asleep
 * (`liveConditionOf`).
 */
export function LiveViewCard({ machine, profile }: { machine: Machine; profile?: unknown }) {
  const { live, curves, openedAt } = useLiveView(machine.id);
  const now = useTimeAfter(staleAtOf(live, openedAt));
  const condition = liveConditionOf({ online: machine.online, mismatched: machine.mismatch !== null, live, openedAt, now });
  const shown = live && (condition === "live" || condition === "stale" || condition === "asleep");
  return (
    <Card role="region" aria-label="Live View">
      <CardHeader>
        <CardTitle className="flex items-center gap-1.5">
          <h2>Live View</h2>
          <InfoTip label="About Live View">
            <p>What the Machine is doing and measuring now, as its Tablet sends it while this page is open.</p>
            <p>Nothing here is stored.</p>
          </InfoTip>
        </CardTitle>
        {condition !== "live" && <ConditionLine condition={condition} machine={machine} live={live} />}
      </CardHeader>
      {shown && (
        <CardContent className={cn("grid gap-6", condition === "stale" && "opacity-50")}>
          <LiveTiles live={live} profile={profile} integratedScale={machine.model === "Bengle"} />
          {/* Keyed, so each shot or steaming starts with what the page held as it began. */}
          {curves.curve && (
            <LiveCurvesSection
              key={curves.curve.startedAt}
              machineId={machine.id}
              curve={curves.curve}
              settled={curves.firstFrameAt !== undefined}
              profile={profile}
              lastShotId={machine.lastShot?.id ?? null}
            />
          )}
        </CardContent>
      )}
    </Card>
  );
}

/** The line saying why the Live View shows nothing live, or that what it shows isn't current. */
function ConditionLine({ condition, machine, live }: { condition: Exclude<LiveCondition, "live">; machine: Machine; live: LiveState | undefined }) {
  switch (condition) {
    case "offline":
      return <CardDescription>{offlineText(machine)}</CardDescription>;
    case "mismatch":
      return <CardDescription>Its Tablet reports other hardware than this Machine's, so nothing live is shown.</CardDescription>;
    case "waiting":
      return <CardDescription>Waiting for its Tablet to send what it is doing.</CardDescription>;
    case "notConnected":
      return <CardDescription>Its Tablet is online, but not connected to the Machine.</CardDescription>;
    case "asleep":
      return (
        <CardDescription className="flex items-center gap-1.5">
          {live?.machine ? `Asleep since ${formatTime(live.machine.stateSince)}` : "Asleep"}
          <InfoTip label="About an asleep Machine">
            <p>Some Machines send nothing while asleep, so these are the values it sent as it went to sleep.</p>
          </InfoTip>
        </CardDescription>
      );
    case "stale":
      return (
        <CardDescription className="flex items-center gap-1.5">
          {live?.machineArrivedAt === undefined ? "No data from the Machine yet" : `No data since ${formatTime(new Date(live.machineArrivedAt).toISOString())}`}
          <InfoTip label="About values not current">
            <p>Nothing has come from the Machine for more than {STALE_AFTER_MS / 1000} s, so the values shown may be out of date.</p>
          </InfoTip>
        </CardDescription>
      );
  }
}

/** An offline Machine on one line: when it was last seen, and its last stored Machine State, since when. */
function offlineText({ lastSeenAt, machineState }: Machine): string {
  if (lastSeenAt === null) return "Offline, never seen.";
  const state = machineState ? `${describeMachineState(machineState)} since ${formatTime(machineState.observedAt)}` : "none reported";
  return `Offline, last seen ${formatTime(lastSeenAt)}, last Machine State: ${state}.`;
}

/** The page's time, as of the last render, rendering again once it passes `at`, by the same clock. */
function useTimeAfter(at: number): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setTimeout(() => setNow(Date.now()), Math.max(0, at - Date.now()) + 1);
    return () => clearTimeout(timer);
  }, [at]);
  return now;
}

/**
 * The latest frame of each source of the Live View, undefined until a frame
 * comes, and its curves, from the Machine's stream, which is open while the
 * page shows it in a visible tab, as the page's polling runs: it is closed
 * while the tab is hidden, and opened again once it is shown, so the plugin
 * stops streaming once nobody sees it. The browser opens a stream that ended
 * again by itself; one it gave up on, as when refused, is opened again after
 * REOPEN_MS. `openedAt` is when the page last opened it, by its own clock.
 */
function useLiveView(machineId: string): { live: LiveState | undefined; curves: LiveCurves; openedAt: number } {
  const [live, setLive] = useState<LiveState>();
  const [curves, setCurves] = useState<LiveCurves>({});
  const [openedAt, setOpenedAt] = useState(Date.now);
  useEffect(() => {
    let source: EventSource | undefined;
    let reopen: ReturnType<typeof setTimeout> | undefined;
    // Frames may be missed from when the stream closes or fails until it is open again.
    const close = () => {
      clearTimeout(reopen);
      source?.close();
      source = undefined;
      setCurves(withStreamGap);
    };
    const open = () => {
      close();
      if (document.hidden) return;
      const opened = new EventSource(`/api/machines/${encodeURIComponent(machineId)}/live`);
      source = opened;
      setOpenedAt(Date.now());
      opened.onmessage = (event: MessageEvent) => {
        const relayed = readLiveEvent(event.data);
        if (!relayed) return;
        const arrivedAt = Date.now();
        setLive((latest) => withLiveFrame(latest, relayed, arrivedAt));
        setCurves((latest) => withCurvesFrame(latest, relayed));
      };
      opened.onerror = () => {
        setCurves(withStreamGap);
        if (opened.readyState !== EventSource.CLOSED) return;
        source = undefined;
        reopen = setTimeout(open, REOPEN_MS);
      };
    };
    // One given up on is opened at once as the tab is shown.
    const visibilityChanged = () => {
      if (document.hidden) close();
      else if (!source) open();
    };
    document.addEventListener("visibilitychange", visibilityChanged);
    open();
    return () => {
      document.removeEventListener("visibilitychange", visibilityChanged);
      close();
    };
  }, [machineId]);
  return { live, curves, openedAt };
}

/**
 * The curves of the latest shot or steaming, drawn as its frames come, as its
 * stored record's page draws them, and labelled partial where it began before
 * the page's frames did. Once it has ended, the record it was stored as is
 * linked as soon as it has arrived (`useStoredRecord`), or, where that can't
 * be told, the Machine's records of its kind. `settled` says the stream has
 * had a machine frame since its last gap. Memoized, so only its own frames
 * draw it again, not the scale's.
 */
const LiveCurvesSection = memo(function LiveCurvesSection({
  machineId,
  curve,
  settled,
  profile,
  lastShotId,
}: {
  machineId: string;
  curve: LiveCurve;
  settled: boolean;
  profile?: unknown;
  lastShotId: string | null;
}) {
  const live = useMemo(() => liveSamples(curve, profile), [curve, profile]);
  const stored = useStoredRecord(machineId, curve, settled, lastShotId);
  const shot = live.activity === "shot";
  const what = shot ? "shot" : "steaming";
  const kind = shot ? "Shot" : "Steam Record";
  return (
    <section aria-label="Curves" className="grid gap-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <div className="flex items-center gap-1.5">
          <h3 className="font-medium">{shot ? "Shot curves" : "Steaming curves"}</h3>
          <InfoTip label="About the curves">
            {shot ? (
              <p>
                Drawn as the shot runs, as its Shot's page draws them: seconds from the start of its profile, with Preheat shaded before 0 s.
                Dashed lines are the targets the Machine reported, and grey vertical lines mark each change of profile step.
              </p>
            ) : (
              <p>
                Drawn as the Machine steams, as its Steam Record's page draws them: seconds from when it started steaming. Dashed lines are
                the targets the Machine reported. Shaded time isn't steaming: Preparing before 0 s, then Paused, Puffing and Purge.
              </p>
            )}
            <p>They stay until the next shot or steaming starts, and aren't stored.</p>
          </InfoTip>
        </div>
        {curve.partial && (
          <span className="flex items-center gap-1.5">
            <Badge variant="outline">Partial</Badge>
            <InfoTip label="About partial curves">
              <p>The {what} began before this page's data started coming, so its start isn't drawn.</p>
            </InfoTip>
          </span>
        )}
        {curve.ended &&
          (stored === "missed" || stored === "unread" ? (
            <span className="flex items-center gap-1.5 text-sm">
              <Link to={`/${shot ? "shots" : "steam-records"}?machineId=${encodeURIComponent(machineId)}`} className="underline underline-offset-4">
                Find its {kind} among the Machine's
              </Link>
              <InfoTip label={`About finding its ${kind}`}>
                <p>
                  {stored === "missed"
                    ? `This page missed what the Machine sent for a while, which may hold the end of this ${what} or another after it, so it can't tell which ${kind} is this one's.`
                    : `This page couldn't read the Machine's ${kind}s while it steamed, so it can't tell which is this one's.`}
                </p>
              </InfoTip>
            </span>
          ) : stored ? (
            <Link to={stored} className="text-sm underline underline-offset-4">
              Open its {kind}
            </Link>
          ) : (
            <span className="text-sm text-muted-foreground">Waiting for its {kind}</span>
          ))}
      </div>
      {live.activity === "shot" ? (
        <Curves curves={SHOT_CURVES} label="This shot" current={live.samples} />
      ) : (
        <Curves<LiveSteamCurve> curves={liveSteamCurves(live.samples)} label="This steaming" current={live.samples} />
      )}
    </section>
  );
});

/**
 * The path of the stored record of the curves' shot or steaming, once it has
 * ended and the record has arrived, null until then, or why its record can't
 * be told from another's: "missed" or "unread". Its own record is stored only once it
 * has ended, so every record the page saw as the Machine's latest while it
 * ran, from the one it held as it began, is another's, such as one before it
 * stored late: the first other the page sees once it has ended, with the
 * stream `settled` after any gap, is linked, and kept. Frames missed in a
 * gap may hold its end or another shot or steaming (`missed`), or no Steam
 * Record was read while it steamed (`unread`). For a shot, the
 * latest is the Machine's last Shot, as the page polls it, by its id, as a
 * Shot's `pulledAt` is rebuilt from its record and may be missing. For
 * steaming, it is the Machine's newest Steam Record, read from when steaming
 * began every STATUS_POLL_MS while the tab is shown, until one is linked or
 * it is unknown; a read made while it steams counts as made while it ran,
 * whenever it is answered. Its component is keyed by the curves, so starts
 * afresh for each.
 */
function useStoredRecord(machineId: string, curve: LiveCurve, settled: boolean, lastShotId: string | null): string | "missed" | "unread" | null {
  const { ended, missed } = curve;
  const steaming = curve.activity === "steaming";
  const seen = useRef<Set<string | null>>(null);
  seen.current ??= new Set(steaming ? [] : [lastShotId]);
  const [linked, setLinked] = useState<string>();
  const [unread, setUnread] = useState(false);
  useEffect(() => {
    if (steaming || linked !== undefined) return;
    if (!ended) seen.current!.add(lastShotId);
    else if (settled && !missed && lastShotId !== null && !seen.current!.has(lastShotId)) setLinked(lastShotId);
  }, [steaming, ended, settled, missed, lastShotId, linked]);
  // Read as each read of the newest Steam Record is made, and as it is answered.
  const running = useRef(!ended);
  const linkable = useRef(false);
  useEffect(() => {
    running.current = !ended;
    linkable.current = ended && settled;
  }, [ended, settled]);
  useEffect(() => {
    if (!steaming || missed) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = async () => {
      if (!document.hidden) {
        const whileRunning = running.current;
        try {
          const path = `/steam-records?machineId=${encodeURIComponent(machineId)}&limit=1`;
          const newest = (await api<SteamRecordPage>("GET", path)).steamRecords[0]?.id ?? null;
          if (stopped) return;
          if (whileRunning) seen.current!.add(newest);
          else if (seen.current!.size === 0) return setUnread(true);
          else if (linkable.current && newest !== null && !seen.current!.has(newest)) return setLinked(newest);
        } catch {
          // Read again next time.
        }
      }
      if (!stopped) timer = setTimeout(() => void read(), STATUS_POLL_MS);
    };
    void read();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [machineId, steaming, missed]);
  if (!ended) return null;
  if (linked !== undefined) return steaming ? `/steam-records/${encodeURIComponent(linked)}` : `/shots/${encodeURIComponent(linked)}`;
  return missed ? "missed" : unread ? "unread" : null;
}

/** Decaid's states while a shot is pulled. */
const SHOT_STATES = new Set(["espresso", "skipStep"]);

/**
 * The tiles of what the Machine measures now. `integratedScale` says its
 * scale is a Bengle's own, as Decaid connects no other to a Bengle
 * (`_runScalePhase` in decaid:lib/src/controllers/connection_manager.dart),
 * whose battery always reads 100 (`IntegratedScaleCapability`), so isn't shown.
 */
function LiveTiles({ live, profile, integratedScale }: { live: LiveState; profile?: unknown; integratedScale: boolean }) {
  const snapshot = live.machine?.snapshot ?? {};
  const named = machineStateOf(snapshot);
  const value = (key: string) => reported(snapshot, key);
  const steamTarget = live.shotSettings ? reported(live.shotSettings, "targetSteamTemp") : null;
  const pulling = named !== null && SHOT_STATES.has(named.state);
  // Before its first step a shot's frame is left over from before it, as the Shot page's curves read it.
  const preheat = pulling && named.substate === "preparingForShot";
  const steps = (profile as { steps?: unknown } | null | undefined)?.steps;
  const step = pulling && !preheat ? profileStep(snapshot.profileFrame, Array.isArray(steps) ? steps : []) : null;
  const stepText = preheat ? "Preheat" : step?.name;
  // A Bengle's milk probe, while it reports.
  const milkTemperature = milkTemperatureOf(live.milkProbe, live.machine?.snapshot);
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
      <Tile label="Machine State" wide>
        <dt className="flex items-center gap-1.5 text-xs text-muted-foreground">
          Machine State
          {named && (
            <InfoTip label="About Machine State">
              <p>
                Decaid reports {named.state}, {named.substate}.
              </p>
              {named.note && <p>{named.note}.</p>}
            </InfoTip>
          )}
        </dt>
        <dd className="flex flex-wrap items-center gap-2 text-lg font-medium">
          {named ? named.name : <NotReported />} {named?.detail && <Badge variant="secondary">{named.detail}</Badge>}
        </dd>
        <TileLine term="Time in state">{(live.machine && timeInState(live.machine)) ?? <NotReported />}</TileLine>
      </Tile>
      <Measurement label="Group temperature" value={value("groupTemperature")} target={value("targetGroupTemperature")} unit="°C" />
      <Measurement label="Mix temperature" value={value("mixTemperature")} target={value("targetMixTemperature")} unit="°C" />
      {/* The steam heater's target is in the machine's shot settings, which Decaid sends on a socket of their own. */}
      <Measurement label="Steam temperature" value={value("steamTemperature")} target={steamTarget} unit="°C" />
      {milkTemperature !== null && <Measurement label="Milk temperature" value={milkTemperature} unit="°C" />}
      {/* A target of zero is a profile step that sets none, as a pressure step's flow target, as the Shot page's curves read it. */}
      <Measurement label="Pressure" value={value("pressure")} target={value("targetPressure")} unit="bar" zeroIsNone />
      <Measurement label="Flow" value={value("flow")} target={value("targetFlow")} unit="ml/s" zeroIsNone />
      <Tile label="Profile step">
        <TileTerm>Profile step</TileTerm>
        <dd className="text-lg font-medium">{stepText ?? <span className="text-muted-foreground">{pulling ? "Not reported" : "Not pulling a shot"}</span>}</dd>
      </Tile>
      <WaterLevel frame={live.waterLevels} />
      <Scale frame={live.scale} battery={!integratedScale} />
      <Tile label="Tablet">
        <TileTerm>Connection to Tablet</TileTerm>
        <dd className="text-lg font-medium">{connectionText(machineConnectedOf(live.devices))}</dd>
      </Tile>
    </div>
  );
}

/** The tank's water level against its refill level, Low at or below it. */
function WaterLevel({ frame }: { frame: Record<string, unknown> | undefined }) {
  const { level, refill, low } = waterLevelOf(frame);
  return (
    <Tile label="Water level">
      <TileTerm>Water level</TileTerm>
      <dd className="flex items-center gap-2 text-lg font-medium tabular-nums">
        {level === null ? <NotReported /> : `${level.toFixed(1)} mm`}
        {low && <Badge variant="destructive">Low</Badge>}
      </dd>
      <div className="flex gap-1 text-xs text-muted-foreground">
        <dt className="flex items-center gap-1">
          Refill level
          <InfoTip label="About the refill level">
            <p>The water level, set on the Machine, at which its tank is due a refill.</p>
            <p>At or below it, the water level is shown as Low.</p>
          </InfoTip>
        </dt>
        <dd className="tabular-nums">{refill === null ? <NotReported /> : `${refill.toFixed(1)} mm`}</dd>
      </div>
    </Tile>
  );
}

/** The scale's weight, weight flow and, unless `battery` is false, its battery, and whether it is connected. */
function Scale({ frame, battery: showBattery }: { frame: Record<string, unknown> | undefined; battery: boolean }) {
  const { connected, weight, weightFlow, battery } = scaleOf(frame);
  return (
    <Tile label="Scale">
      <TileTerm>Weight</TileTerm>
      <dd className="text-lg font-medium tabular-nums">{weight === null ? <NotReported /> : `${weight.toFixed(1)} g`}</dd>
      <TileLine term="Weight flow">{weightFlow === null ? <NotReported /> : `${weightFlow.toFixed(1)} g/s`}</TileLine>
      {showBattery && <TileLine term="Battery">{battery === null ? <NotReported /> : `${Math.round(battery)} %`}</TileLine>}
      <TileLine term="Scale">{connectionText(connected)}</TileLine>
    </Tile>
  );
}

function connectionText(connected: boolean | null): ReactNode {
  if (connected === null) return <NotReported />;
  return connected ? "Connected" : "Not connected";
}

/** One tile: a small card holding its terms and values. */
function Tile({ label, wide = false, children }: { label: string; wide?: boolean; children: ReactNode }) {
  return (
    <Card size="sm" role="group" aria-label={label} className={wide ? "col-span-2" : undefined}>
      <CardContent>
        <dl className="grid gap-1">{children}</dl>
      </CardContent>
    </Card>
  );
}

function TileTerm({ children }: { children: ReactNode }) {
  return <dt className="text-xs text-muted-foreground">{children}</dt>;
}

/** A smaller term and value under a tile's own, such as a target. */
function TileLine({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div className="flex gap-1 text-xs text-muted-foreground">
      <dt>{term}</dt>
      <dd className="tabular-nums">{children}</dd>
    </div>
  );
}

/**
 * A measurement against its target, if it has one, each shown as not
 * reported where Decaid sends none. With `zeroIsNone`, a target of zero or
 * less is none.
 */
function Measurement({
  label,
  value,
  target,
  unit,
  zeroIsNone = false,
}: {
  label: string;
  value: number | null;
  target?: number | null;
  unit: string;
  zeroIsNone?: boolean;
}) {
  const targetText = target === null || target === undefined ? null : zeroIsNone && target <= 0 ? "None" : `${target.toFixed(1)} ${unit}`;
  return (
    <Tile label={label}>
      <TileTerm>{label}</TileTerm>
      <dd className="text-lg font-medium tabular-nums">{value === null ? <NotReported /> : `${value.toFixed(1)} ${unit}`}</dd>
      {target !== undefined && <TileLine term="Target">{targetText ?? <NotReported />}</TileLine>}
    </Tile>
  );
}

function NotReported() {
  return <span className="text-muted-foreground">Not reported</span>;
}
