import type { PluginHost } from "./host.js";

/**
 * The plugin's one notice in Decaid's notification center, which Decaid shows
 * as a bell over any Skin (#540): put up while the plugin has stopped syncing
 * and withdrawn once that ends. Decaid keeps a notice across a reload of the
 * plugin and a restart of Decaid, and removes it when the plugin is disabled
 * or removed (`host.notify` in decaid:doc/Plugins.md).
 */
export const NOTICE_ID = "sync";

/** How long the server is out of reach, without a connection welcomed in between, before the notice says so. */
export const UNREACHABLE_NOTICE_MS = 10 * 60_000;

export type NoticeReason = "decaidTooOld" | "pluginTooOld" | "tokenRefused" | "hardwareDismissed" | "anotherTablet" | "unreachable";

const SAVED = "Shots still save on this tablet and will upload later.";
const MANAGER = "Someone who manages Decent Sync";

/**
 * What each notice says, in plain English and with no link: that nothing is
 * lost, why the plugin stopped, then who can fix it. Each fits Decaid's limit
 * of 600 characters (site/src/content/docs/reference/tablet-plugin.md, When the plugin stops syncing, lists them).
 */
export const NOTICES: Readonly<Record<NoticeReason, string>> = {
  decaidTooOld: `${SAVED} Decent Sync stopped syncing because this tablet's Decaid is older than the Decent Sync server supports. ${MANAGER} can update Decaid on this tablet.`,
  pluginTooOld: `${SAVED} Decent Sync stopped syncing because this tablet's Decent Sync plugin is older than the server supports. ${MANAGER} can update the plugin.`,
  tokenRefused: `${SAVED} Decent Sync stopped syncing because the server refused the token in this plugin's settings. ${MANAGER} can enter this machine's current token there.`,
  hardwareDismissed: `${SAVED} Decent Sync stopped syncing because an Admin dismissed the espresso machine connected to this tablet for the token in this plugin's settings. ${MANAGER} can give this machine a token of its own.`,
  anotherTablet: `${SAVED} Decent Sync stopped syncing because another tablet is connected with this machine's token, and it starts again once that tablet disconnects. ${MANAGER} can check which tablet should use the token.`,
  unreachable: `${SAVED} Decent Sync has not reached its server for 10 minutes. Whoever looks after this tablet's network can check that it is online and can reach the server.`,
};

/** What a log line calls each notice. */
const NAMES: Readonly<Record<NoticeReason, string>> = {
  decaidTooOld: "Decaid is too old",
  pluginTooOld: "the plugin is too old",
  tokenRefused: "the token was refused",
  hardwareDismissed: "this hardware was dismissed",
  anotherTablet: "another tablet holds the Machine",
  unreachable: "the server is out of reach",
};

/**
 * Puts the notice up for one reason at a time, replacing the last, and
 * withdraws it. It asks Decaid to put one up only when the reason changes,
 * so a notice Decaid refuses is logged and asked for again only once the
 * reason changes, never in a loop. A withdrawal is asked for each time.
 *
 * A load starts not knowing what an earlier load left up. The first outcome
 * of its first connection settles it: a welcome withdraws it, a refusal puts
 * up its own notice in its place, kept as it was where it says the same, and
 * an attempt that fails withdraws it, as this load has not yet seen the
 * server out of reach for 10 minutes.
 */
export class TabletNotice {
  /** The reason up now, null for none, undefined until this load has put one up or withdrawn it. */
  private shown: NoticeReason | null | undefined;
  /** The notices asked for whose result Decaid has not sent yet, by request id. */
  private readonly pending = new Map<string, NoticeReason>();
  /** The last notice asked for, and the reason this load had put up before it, if any. */
  private latest: { requestId: string; replaced: NoticeReason | null | undefined } | undefined;

  constructor(
    private readonly host: PluginHost,
    private readonly log: (message: string) => void,
  ) {}

  show(reason: NoticeReason): void {
    if (this.shown === reason) return;
    const replaced = this.shown;
    this.shown = reason;
    this.latest = undefined;
    try {
      const requestId = this.host.notify({ id: NOTICE_ID, message: NOTICES[reason] });
      if (typeof requestId === "string") {
        this.pending.set(requestId, reason);
        this.latest = { requestId, replaced };
      }
    } catch (error) {
      this.log(`Decaid refused the notice on the tablet that ${NAMES[reason]}: ${describe(error)}`);
    }
  }

  /**
   * Asks Decaid to withdraw the notice, whatever this load thinks shows:
   * Decaid sends no result for a withdrawal, and one whose save fails leaves
   * the notice up, so each call asks again. Withdrawing a notice Decaid
   * doesn't hold changes and saves nothing there (`removeSource` in
   * notification_center.dart). Only while Decaid holds one it can't save
   * the removal of does each call cost a failed save and a line in Decaid's
   * log.
   */
  withdraw(): void {
    this.shown = null;
    this.dismiss();
  }

  private dismiss(): void {
    try {
      this.host.dismissNotification(NOTICE_ID);
    } catch (error) {
      this.log(`Decaid refused to withdraw the notice on the tablet: ${describe(error)}`);
    }
  }

  /** Withdraws what an earlier load may have left up, unless this load has already decided what shows. */
  settle(): void {
    if (this.shown === undefined) this.withdraw();
  }

  /**
   * Decaid's `notificationResult` event: a notice it did not keep is logged.
   * Where it was the last asked for and replaced one this load put up, that
   * one is withdrawn, as its reason no longer holds. What an earlier load
   * left up stays, as it may say just what this load asked for. The refused
   * notice is not asked for again.
   */
  result(payload: unknown): void {
    if (typeof payload !== "object" || payload === null) return;
    const { requestId, status, reason } = payload as Record<string, unknown>;
    if (typeof requestId !== "string") return;
    const asked = this.pending.get(requestId);
    if (asked === undefined) return;
    this.pending.delete(requestId);
    if (status === "accepted") return;
    this.log(
      `Decaid did not keep the notice on the tablet that ${NAMES[asked]} (${typeof reason === "string" ? reason : String(status)}). It is not asked for again until what the notice should say changes.`,
    );
    const latest = this.latest;
    this.latest = undefined;
    if (latest?.requestId === requestId && this.shown === asked && latest.replaced) this.dismiss();
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
