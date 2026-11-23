import { describe, expect, it } from "vitest";
import type { PluginHost } from "../src/host.js";
import { NOTICES, TabletNotice } from "../src/tablet-notice.js";

// What the plugin's one notice does with Decaid's answers (#540), on a host that only records the asks. Seam 1 covers
// each condition on a simulated tablet (server/test/tablet-notices.test.ts).

function recordingHost() {
  const calls: (["notify", string] | ["dismiss", string | undefined])[] = [];
  let requests = 0;
  const host = {
    notify: (notice: { id: string; message: string }) => {
      calls.push(["notify", notice.message]);
      return `notice_${++requests}`;
    },
    dismissNotification: (id?: string) => {
      calls.push(["dismiss", id]);
    },
  } as unknown as PluginHost;
  return { host, calls };
}

describe("The notice on the tablet", () => {
  it("withdraws the notice Decaid refused to replace, as its reason no longer holds, and asks for neither again", () => {
    const { host, calls } = recordingHost();
    const logs: string[] = [];
    const notice = new TabletNotice(host, (message) => logs.push(message));

    notice.show("anotherTablet");
    notice.result({ requestId: "notice_1", id: "sync", status: "accepted" });
    notice.show("unreachable");
    notice.result({ requestId: "notice_2", id: "sync", status: "rejected", reason: "storage" });
    notice.show("unreachable");

    expect(calls).toEqual([
      ["notify", NOTICES.anotherTablet],
      ["notify", NOTICES.unreachable],
      ["dismiss", "sync"],
    ]);
    expect(logs).toEqual([expect.stringMatching(/^Decaid did not keep the notice on the tablet that the server is out of reach \(storage\)\./)]);
  });

  it("leaves a later notice alone when an earlier one is refused", () => {
    const { host, calls } = recordingHost();
    const notice = new TabletNotice(host, () => {});

    notice.show("anotherTablet");
    notice.show("unreachable");
    notice.result({ requestId: "notice_1", id: "sync", status: "rejected", reason: "storage" });

    expect(calls).toEqual([
      ["notify", NOTICES.anotherTablet],
      ["notify", NOTICES.unreachable],
    ]);
  });
});
