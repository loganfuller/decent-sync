import { type PluginMessage, type ShotDelivery, encode } from "@decent-sync/protocol";
import { describe, expect, it } from "vitest";
import { Sender } from "../src/sender.js";

// The plugin's sender of one connection's messages, through its own
// interface: what it hands Decaid, and when. What it counts and holds back
// is tested through Seam 1 (server/test/chunked-messages.test.ts); here, the
// messages carrying an id that the server neither acknowledges nor confirms.
// The messages are made up: only their sizes and types matter.

/** A Shot delivery whose one frame is `bytes` bytes. */
function delivery(id: string, bytes: number): ShotDelivery {
  const sized = (notes: string): ShotDelivery => ({ type: "shot", id, shotId: id, shot: { notes } });
  return sized("n".repeat(bytes - encode(sized("")).length));
}

describe("The plugin's sender", () => {
  it("sends the answer to an edit of a Shot at once, ahead of a delivery waiting for room, and counts none of it", async () => {
    const frames: string[] = [];
    const sender = new Sender(async (frame) => void frames.push(frame));
    const sent = () => frames.map((frame) => (JSON.parse(frame) as PluginMessage).type);
    // Two deliveries fill what may await the server's confirmation, to within 288 bytes, so a third waits.
    const deliveries = ["first", "second", "third"].map((id) => delivery(id, 262_000));
    const handed = deliveries.map((message) => sender.send(message));
    await Promise.all(handed.slice(0, 2));
    expect(sent()).toEqual(["shot", "shot"]);

    // Longer than the room left: counted, it would wait behind the third delivery, and hold it back in turn.
    const answer: PluginMessage = { type: "shotEdited", id: "019a2f3e-7c41-7b9e-8a1d-5f3c2e4b6a72", outcome: "refused", status: 500, error: "e".repeat(600) };
    await sender.send(answer);
    expect(sent()).toEqual(["shot", "shot", "shotEdited"]);
    expect(JSON.parse(frames[2]!)).toEqual(answer);

    // The first delivery acknowledged, the third has room: the answer took none.
    sender.acknowledged("first");
    await handed[2];
    expect(sent()).toEqual(["shot", "shot", "shotEdited", "shot"]);
  });
});
