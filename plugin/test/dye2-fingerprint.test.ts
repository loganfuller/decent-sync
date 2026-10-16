import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { dye2Fingerprint } from "../src/loaded-recipe-rules.js";

// The plugin tells DYE2's change of profile as DYE2 does, by its fingerprint
// of the Workflow's profile: checked byte for byte against the
// `profileFingerprint` DYE2 at 2cf631c stored as it selected a recipe, for the
// profile as Decaid's `workflowUpdated` event carried it to plugins and as
// `GET /workflow` answered it (server/test/fixtures/decaid/dye2-2cf631c/,
// fingerprints.json).

interface Recorded {
  name: string;
  workflowUpdated: unknown;
  workflow: unknown;
  profileFingerprint: string;
}

const recorded = JSON.parse(
  fs.readFileSync(path.resolve(import.meta.dirname, "../../server/test/fixtures/decaid/dye2-2cf631c/fingerprints.json"), "utf8"),
) as Recorded[];

describe("dye2Fingerprint", () => {
  it.each(recorded.map((entry) => [entry.name, entry] as const))("is DYE2's own for the profile it selected %s on", (_name, entry) => {
    expect(entry.profileFingerprint).toEqual(expect.any(String));
    expect(dye2Fingerprint(entry.workflowUpdated)).toBe(entry.profileFingerprint);
    expect(dye2Fingerprint(entry.workflow)).toBe(entry.profileFingerprint);
  });
});
