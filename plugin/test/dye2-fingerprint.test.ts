import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { dye2Fingerprint } from "@decent-sync/protocol";

// The plugin tells DYE2's change of profile as DYE2 does, by its fingerprint
// of the Workflow's profile: checked against v0.1.26's `profileFingerprint`,
// as the recording computed it after each recipe applied, for the profile as
// Decaid's `workflowUpdated` event carried it to plugins, as `GET /workflow`
// answered it, and as the recipe's record embeds it
// (server/test/fixtures/decaid/dye2-v0.1.26/, fingerprints.json).

interface Recorded {
  name: string;
  fingerprints: Record<string, string | null>;
  [profile: string]: unknown;
}

const recorded = JSON.parse(
  fs.readFileSync(path.resolve(import.meta.dirname, "../../server/test/fixtures/decaid/dye2-v0.1.26/fingerprints.json"), "utf8"),
) as Recorded[];

describe("dye2Fingerprint", () => {
  it.each(recorded.map((entry) => [entry.name, entry] as const))("is DYE2's own for each profile left by the apply %s", (_name, entry) => {
    expect(Object.keys(entry.fingerprints)).toEqual(expect.arrayContaining(["workflowUpdated", "workflow", "recipeWorkflowProfile"]));
    for (const [key, fingerprint] of Object.entries(entry.fingerprints)) {
      expect(dye2Fingerprint(entry[key]), key).toBe(fingerprint);
      if (entry[key]) expect(fingerprint, key).toEqual(expect.any(String));
    }
  });
});
