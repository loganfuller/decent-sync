import { REQUESTS_WIRE_REVISION, type SkinAnswer, type SkinAsk, type SkinRequest, peerHasWireRevision } from "@decent-sync/protocol";
import type { Outbox } from "./outbox.js";

/**
 * Whether each ask goes out behind what the outbox held as the Skin asked
 * (`Outbox.whenDelivered`), so that an answer about a record follows that
 * record's delivery, as one about a Shot just pulled must (ADR-0030), or at
 * once. `status` reads only where the Machine takes part, which nothing the
 * tablet reports changes, so it goes at once: behind a tablet's backlog
 * after an outage it would run out of time for nothing. An ask that reads
 * or names what the tablet delivers follows it.
 */
export const FOLLOWS_REPORTS: Readonly<Record<SkinAsk, boolean>> = { status: false };

/**
 * How long a request has to be answered, from when the Skin asked: its wait
 * behind the outbox, where it has one, its way to the server and the
 * answer's way back. One unanswered by then is answered to the Skin as
 * unreachable, well inside the 30 s Decaid gives a plugin to answer an HTTP
 * request (`pluginHttpTimeout` in decaid:lib/src/plugins/plugin_manager.dart).
 */
export const SKIN_REQUEST_MS = 10_000;

/**
 * Why a request has no answer: the server can't be reached (the plugin is
 * not connected, the connection closed before the answer came, or the answer
 * did not come in time), or the server the plugin is connected to is of the
 * release before requests, as during an upgrade (ADR-0025).
 */
export type Unanswered = "unreachable" | "serverTooOld";

/** What became of a request: the server's answer, or why there is none. */
export type Asked = { answer: SkinAnswer } | { unanswered: Unanswered };

/**
 * What the plugin asks the server for a Skin on its tablet (ADR-0030): each
 * request goes out on the connection welcomed as the Skin asked, at once or,
 * for an ask that follows the tablet's reports (FOLLOWS_REPORTS), once the
 * server has acknowledged what the outbox held then (`Outbox.whenDelivered`),
 * and is matched to its answer by its id. A request is never kept, and never
 * sent again: it is answered as unreachable at once while the plugin is not
 * connected, when its connection closes, and once SKIN_REQUEST_MS have
 * passed, an answer arriving after that being dropped; and as too old to ask
 * while the server is not at the wire revision requests came in.
 */
export class SkinRequests {
  /** The welcomed connection, with the wire revision its server's welcome gave. */
  private connection?: { send(request: SkinRequest): Promise<void>; serverRevision: number };
  /** The requests awaiting an answer, by id, each with what settles it. */
  private readonly pending = new Map<string, (asked: Asked) => void>();

  constructor(
    private readonly outbox: Pick<Outbox, "nextId" | "whenDelivered">,
    /** Which asks follow the tablet's reports: FOLLOWS_REPORTS, but in a test of one that does while none yet does. */
    private readonly followsReports: Readonly<Record<SkinAsk, boolean>> = FOLLOWS_REPORTS,
  ) {}

  /** Whether the plugin holds a connection the server welcomed. */
  get connected(): boolean {
    return this.connection !== undefined;
  }

  /** The server welcomed a connection, whose `send` sends a request on it. */
  welcomed(send: (request: SkinRequest) => Promise<void>, serverRevision: number): void {
    this.connection = { send, serverRevision };
  }

  /** The connection closed: its requests have no answer to come. */
  disconnected(): void {
    this.connection = undefined;
    for (const settle of [...this.pending.values()]) settle({ unanswered: "unreachable" });
  }

  /** The server answered a request; an answer to none awaited, as one that came too late, is dropped. */
  answered(answer: SkinAnswer): void {
    this.pending.get(answer.id)?.({ answer });
  }

  /** Asks the server, and resolves with its answer or why there is none. It never rejects. */
  ask(ask: SkinAsk): Promise<Asked> {
    const connection = this.connection;
    if (!connection) return Promise.resolve({ unanswered: "unreachable" });
    if (!peerHasWireRevision(connection.serverRevision, REQUESTS_WIRE_REVISION)) return Promise.resolve({ unanswered: "serverTooOld" });
    const id = this.outbox.nextId();
    return new Promise((resolve) => {
      let giveUp = () => {};
      const settle = (asked: Asked) => {
        if (!this.pending.delete(id)) return;
        clearTimeout(timer);
        giveUp();
        resolve(asked);
      };
      const timer = setTimeout(() => settle({ unanswered: "unreachable" }), SKIN_REQUEST_MS);
      this.pending.set(id, settle);
      const send = () => void connection.send({ type: "request", id, ask }).catch(() => settle({ unanswered: "unreachable" }));
      if (!this.followsReports[ask]) return send();
      giveUp = this.outbox.whenDelivered((delivered) => {
        if (!delivered) return settle({ unanswered: "unreachable" });
        // Settled already, as by its time running out while it waited.
        if (this.pending.has(id)) send();
      });
    });
  }
}
