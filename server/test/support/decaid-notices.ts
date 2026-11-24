// Decaid's notification center, as a simulated tablet's plugins reach it through `host.notify` and
// `host.dismissNotification`, which the `notifications` permission gives a plugin (Decaid v0.9.3: `notify` and
// `dismissNotification` in decaid:lib/src/plugins/plugin_manager.dart, `parsePluginNotification` in
// lib/src/plugins/plugin_notifications.dart, `NotificationCenter` in lib/src/notifications/notification_center.dart).
// What it accepts and refuses, how it numbers revisions, and what it keeps across a reload, a restart and a
// disable follow `server/test/fixtures/decaid/notices-v0.9.3/`, which `decaid-notices.test.ts` replays against it.
//
// It is kept across loads of the plugin, as the plugins and storage are (`SimulatedTabletOptions.notices`): a
// reload, an update and Decaid starting again keep what it holds, as Decaid does. Disabling the plugin removes its
// notices (`removeSource`).

/** A notice the center holds, as Decaid saves it (`private.notificationCenter.v1`), but for its namespace, always `plugin` here. */
export interface HeldNotice {
  sourceId: string;
  sourceName: string;
  id: string;
  message: string;
  actions: unknown[];
  revision: number;
  read: boolean;
}

/** What Decaid's `notificationResult` event carries for a request. */
export interface NoticeResult {
  requestId: string;
  id?: string;
  status: "accepted" | "rejected";
  reason?: "validation" | "capacity" | "storage";
}

/** At most this many notices a plugin, and plugin notices overall (`publish` in notification_center.dart). */
const PER_PLUGIN = 5;
const PER_CENTER = 20;

/** Decaid's `notificationText`: a string, not blank, at most `max` UTF-16 code units, without control characters but tab and line feed. */
function noticeText(value: unknown, max: number): string | undefined {
  if (typeof value !== "string" || value.trim() === "" || value.length > max) return undefined;
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x08\x0b-\x1f\x7f]/.test(value)) return undefined;
  return value;
}

export class NotificationCenter {
  private held: HeldNotice[] = [];
  /** The highest revision given, which the next changed notice goes past. */
  private revision = 0;
  /** Saves that fail before the center changes, as Decaid's do when its preferences can't be written: a notice's with `storage`, a withdrawal's without a word. */
  private failingSaves = 0;
  /** Each call a plugin made, in order: a notice it asked for, with what came of it, or a withdrawal. */
  readonly calls: ({ op: "notify"; pluginId: string; notice: unknown; result: Omit<NoticeResult, "requestId"> } | { op: "dismiss"; pluginId: string; id: string | null })[] = [];

  /** What the center holds now, in its order, of one plugin's notices or every plugin's. */
  shown(pluginId?: string): HeldNotice[] {
    return structuredClone(this.held.filter((notice) => pluginId === undefined || notice.sourceId === pluginId));
  }

  /** Fails the next `count` saves, of a notice or a withdrawal, the center left as it was. */
  failNextSaves(count: number): void {
    this.failingSaves = count;
  }

  /**
   * A notice a plugin asked for: put up, replacing one of its notices with
   * the same id in place, or refused. A notice whose message and actions are
   * the same as the one it replaces keeps that one's revision and read state.
   */
  publish(pluginId: string, sourceName: string, payload: unknown): Omit<NoticeResult, "requestId"> {
    const result = this.decide(pluginId, sourceName, payload);
    this.calls.push({ op: "notify", pluginId, notice: structuredClone(payload), result });
    return result;
  }

  /**
   * Withdraws a plugin's notice with that id, or every one of its notices for
   * none. Unknown ids change nothing and save nothing. A save that fails
   * leaves the notices up, and the plugin is not told, as Decaid sends no
   * result for a withdrawal (`removeSource` in notification_center.dart).
   */
  dismiss(pluginId: string, id: unknown): void {
    this.calls.push({ op: "dismiss", pluginId, id: id === undefined || id === null ? null : String(id) });
    const kept = this.held.filter((notice) => notice.sourceId !== pluginId || (id !== undefined && id !== null && notice.id !== id));
    if (kept.length === this.held.length) return;
    if (this.failingSaves > 0) {
      this.failingSaves--;
      return;
    }
    this.held = kept;
  }

  /** Removes a plugin's notices, as disabling, removing or uninstalling it does. */
  removeSource(pluginId: string): void {
    this.held = this.held.filter((notice) => notice.sourceId !== pluginId);
  }

  /** Decaid starting again: the center is read back from what it saved, its revisions counted on from the highest held. */
  restarted(): void {
    this.revision = this.held.reduce((highest, notice) => Math.max(highest, notice.revision), 0);
  }

  private decide(pluginId: string, sourceName: string, payload: unknown): Omit<NoticeResult, "requestId"> {
    const object = typeof payload === "object" && payload !== null && !Array.isArray(payload) ? (payload as Record<string, unknown>) : undefined;
    const id = noticeText(object?.id, 128);
    const refused = (reason: NoticeResult["reason"]) => ({ ...(id === undefined ? {} : { id }), status: "rejected" as const, reason });
    const message = noticeText(object?.message, 600);
    // An action is not simulated: the plugin puts up none, and a test that sends one is told.
    if (object === undefined || id === undefined || message === undefined || (object.action !== undefined && object.action !== null)) return refused("validation");
    const index = this.held.findIndex((notice) => notice.sourceId === pluginId && notice.id === id);
    const previous = index < 0 ? undefined : this.held[index];
    if (!previous && (this.held.length >= PER_CENTER || this.held.filter((notice) => notice.sourceId === pluginId).length >= PER_PLUGIN)) {
      return refused("capacity");
    }
    if (this.failingSaves > 0) {
      this.failingSaves--;
      return refused("storage");
    }
    const same = previous !== undefined && previous.message === message;
    const notice: HeldNotice = { sourceId: pluginId, sourceName, id, message, actions: [], revision: same ? previous.revision : this.revision + 1, read: same && previous.read };
    if (index < 0) this.held.push(notice);
    else this.held[index] = notice;
    this.revision = Math.max(this.revision, notice.revision);
    return { id, status: "accepted" };
  }
}
