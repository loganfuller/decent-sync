import fs from "node:fs";
import path from "node:path";
import { FIRST_WIRE_REVISION, WIRE_REVISION, acceptsWireRevision, peerHasWireRevision, wireRevisionOf } from "@decent-sync/protocol";
import { describe, expect, it } from "vitest";
import { repoDir } from "../../server/test/support/build-table.mjs";
import { latestReleaseTag, releaseWireRevision, wireRevisionIn } from "../../server/test/support/latest-release.mjs";

// The wire revision's rules (ADR-0025), for any revisions: which peers a
// build accepts, and which have what a revision added.

describe("the wire revision", () => {
  it("is 1 for a peer that sends none, as every release before it is", () => {
    expect(FIRST_WIRE_REVISION).toBe(1);
    expect(wireRevisionOf({ type: "welcome", protocolVersion: 1, heartbeatIntervalMs: 30_000 })).toBe(1);
    expect(wireRevisionOf({ type: "welcome", protocolVersion: 1, wireRevision: 4, heartbeatIntervalMs: 30_000 })).toBe(4);
  });

  it("accepts a peer no more than one revision behind, or any revision ahead", () => {
    const cases: [own: number, accepted: number[], refused: number[]][] = [
      [1, [1, 2, 9], []],
      [2, [1, 2, 3], []],
      [3, [2, 3, 4], [1]],
      [7, [6, 7, 12], [1, 4, 5]],
    ];
    for (const [own, accepted, refused] of cases) {
      for (const peer of accepted) expect(acceptsWireRevision(peer, own), `${peer} at ${own}`).toBe(true);
      for (const peer of refused) expect(acceptsWireRevision(peer, own), `${peer} at ${own}`).toBe(false);
    }
  });

  it("says whether a peer has a revision only while some peer accepted lacks it", () => {
    expect(peerHasWireRevision(1, 2, 2)).toBe(false);
    expect(peerHasWireRevision(2, 2, 2)).toBe(true);
    expect(peerHasWireRevision(3, 2, 2)).toBe(true);
    expect(peerHasWireRevision(4, 5, 5)).toBe(false);
    expect(peerHasWireRevision(9, 5, 5)).toBe(true);
  });

  it("fails, saying to delete the check or move it to the current revision, when asked about a revision every peer accepted has", () => {
    // Once the wire has moved on, every peer within the window has the revision before.
    expect(() => peerHasWireRevision(3, 2, 3)).toThrow(
      "Every peer that wire revision 3 accepts has revision 2: delete this check, or, if what it sends came after the latest release, ask for revision 3",
    );
    expect(() => peerHasWireRevision(7, 4, 7)).toThrow(/delete this check/);
    // At revision 2 every peer has 1, the revision of a peer that sends none.
    expect(() => peerHasWireRevision(2, 1, 2)).toThrow(/delete this check/);
    // At the first revision there is nothing for a peer to lack.
    expect(() => peerHasWireRevision(1, 1, 1)).toThrow(/delete this check/);
    expect(() => peerHasWireRevision(1, 0, 1)).toThrow(/delete this check/);
  });

  it("fails, saying to raise WIRE_REVISION, when asked about a revision the build doesn't speak", () => {
    expect(() => peerHasWireRevision(2, 2, 1)).toThrow("Asked whether a peer has wire revision 2, but this build speaks 1: raise WIRE_REVISION");
    expect(() => peerHasWireRevision(9, WIRE_REVISION + 1)).toThrow(/raise WIRE_REVISION/);
  });

  it("is the latest release's, or one above it", () => {
    // Read as the release's is, so that a change to how it is written can't go unread.
    expect(wireRevisionIn(fs.readFileSync(path.join(repoDir, "protocol/src/index.ts"), "utf8"))).toBe(WIRE_REVISION);
    // Fails, saying to fetch them, without the tags.
    const tag = latestReleaseTag();
    const released = releaseWireRevision(tag);
    expect(
      WIRE_REVISION - released,
      `WIRE_REVISION is ${WIRE_REVISION} and ${tag}'s is ${released}: the first change to the wire after a release raises it by one, and later ones share that revision`,
    ).toBeLessThanOrEqual(1);
    expect(WIRE_REVISION, `WIRE_REVISION is below ${tag}'s ${released}`).toBeGreaterThanOrEqual(released);
  });
});
