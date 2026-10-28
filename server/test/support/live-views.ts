import type { RelayedLiveFrame } from "@decent-sync/protocol";
import type { AdminApi } from "./admin-api.js";
import { opened } from "./test-scope.js";

// A Machine's Live View read as the browser's `EventSource` reads it
// (`GET /api/machines/:id/live`, a Server-Sent Events stream), through the
// REST API with an account's session. Vitest's setup closes the streams a
// test opened once it has run (test-scope.ts).

export interface LiveViewStream {
  /** The status the route answered. */
  readonly status: number;
  /** Its `Content-Type`. */
  readonly contentType: string | null;
  /** Each event's data, read as the relayed live frame it is, in order. */
  readonly events: RelayedLiveFrame[];
  /** Each comment's text, such as a keep-alive's. */
  readonly comments: string[];
  /** Set once the server ended the stream. */
  readonly ended: boolean;
  /** Closes the stream, as leaving the page does. Rejects, once, if it failed, as when its instance was lost. */
  close(): Promise<void>;
}

/** Opens the Machine's Live View as the account `api` is signed in as, resolving once the route has answered. */
export async function openLiveView(api: AdminApi, machineId: string): Promise<LiveViewStream> {
  const abort = new AbortController();
  const response = await api.eventStream(`/machines/${machineId}/live`, abort.signal);
  const events: RelayedLiveFrame[] = [];
  const comments: string[] = [];
  let ended = false;
  let failure: unknown;
  const reading = read(response, events, comments, abort.signal)
    .catch((error: unknown) => (failure = error))
    .finally(() => (ended = true));
  const stream: LiveViewStream = {
    status: response.status,
    contentType: response.headers.get("content-type"),
    events,
    comments,
    get ended() {
      return ended;
    },
    async close() {
      abort.abort();
      await reading;
      const failed = failure;
      failure = undefined;
      if (failed) throw failed;
    },
  };
  opened({ end: () => stream.close() });
  return stream;
}

/** Reads the stream's events and comments as they arrive, until it ends or is closed. */
async function read(response: Response, events: RelayedLiveFrame[], comments: string[], signal: AbortSignal): Promise<void> {
  if (!response.body || !response.headers.get("content-type")?.startsWith("text/event-stream")) {
    await response.body?.cancel().catch(() => {});
    return;
  }
  const decoder = new TextDecoder();
  let buffered = "";
  try {
    for await (const chunk of response.body) {
      buffered += decoder.decode(chunk, { stream: true });
      let end: number;
      while ((end = buffered.indexOf("\n\n")) >= 0) {
        const block = buffered.slice(0, end);
        buffered = buffered.slice(end + 2);
        const data: string[] = [];
        for (const line of block.split("\n")) {
          if (line.startsWith(":")) comments.push(line.slice(1).trim());
          else if (line.startsWith("data:")) data.push(line.slice("data:".length).replace(/^ /, ""));
        }
        if (data.length > 0) events.push(JSON.parse(data.join("\n")) as RelayedLiveFrame);
      }
    }
  } catch (error) {
    // Closed by the test.
    if (!signal.aborted) throw error;
  }
}
