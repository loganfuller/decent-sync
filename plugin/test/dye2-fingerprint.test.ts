import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { dye2Fingerprint } from "@decent-sync/protocol";

// The plugin tells DYE2's change of profile as DYE2 does, by its fingerprint
// of the Workflow's profile: checked against v0.1.26's `profileFingerprint`,
// as the recording computed it after each recipe applied, for the profile as
// Decaid's `workflowUpdated` event carried it to plugins, as `GET /workflow`
// answered it, and as the recipe's record embeds it
// (server/test/fixtures/decaid/dye2-v0.1.26/, fingerprints.json), with every
// object's keys sorted, as v0.1.33's is, the one change since
// (decentespresso/dye2#43, `026054e`); and for a profile a record holds in
// PostgreSQL's `jsonb` key order, as the server writes one, and the Workflow
// holds in Decaid's, as v0.1.33 was recorded keeping the recipe named across
// them (server/test/fixtures/decaid/dye2-v0.1.33/, applies.json).

type Record_ = Record<string, unknown>;

interface Recorded {
  name: string;
  fingerprints: Record<string, string | null>;
  [profile: string]: unknown;
}

interface Exchange {
  request: { method: string; path: string; body?: unknown };
  response: { status: number; body: unknown };
}

const fixtures = path.resolve(import.meta.dirname, "../../server/test/fixtures/decaid");
const read = <T>(file: string) => JSON.parse(fs.readFileSync(path.join(fixtures, file), "utf8")) as T;

const recorded = read<Recorded[]>("dye2-v0.1.26/fingerprints.json");

/** JSON text with every object's keys sorted, as DYE2 v0.1.33's `sortKeysReplacer` writes its fingerprint. */
function sortedText(text: string): string {
  return JSON.stringify(JSON.parse(text), (_key, value: unknown) =>
    isObject(value) ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, value[key]])) : value,
  );
}

/** A copy of the value with each object's keys in reverse order, arrays kept in theirs. */
function reversed(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reversed);
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.keys(value).reverse().map((key) => [key, reversed(value[key])]));
}

function isObject(value: unknown): value is Record_ {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

describe("dye2Fingerprint", () => {
  it.each(recorded.map((entry) => [entry.name, entry] as const))("is DYE2's own for each profile left by the apply %s, its keys sorted", (_name, entry) => {
    expect(Object.keys(entry.fingerprints)).toEqual(expect.arrayContaining(["workflowUpdated", "workflow", "recipeWorkflowProfile"]));
    for (const [key, fingerprint] of Object.entries(entry.fingerprints)) {
      expect(dye2Fingerprint(entry[key]), key).toBe(fingerprint === null ? null : sortedText(fingerprint));
      if (entry[key]) expect(fingerprint, key).toEqual(expect.any(String));
      // Whatever order the profile holds its keys in, at every level.
      expect(dye2Fingerprint(reversed(entry[key])), key).toBe(dye2Fingerprint(entry[key]));
    }
  });

  it("is the same for a profile a record holds in jsonb's key order and the Workflow holds in Decaid's, which DYE2 v0.1.33 kept the recipe named across (applies.json)", () => {
    const copies = read<{ profileCopies: Record<string, Record_> }>("dye2-v0.1.33/library.json").profileCopies;
    const steps = read<Record<string, { exchanges: Exchange[]; after: Exchange[] }>>("dye2-v0.1.33/applies.json");
    const copy = (shorthand: unknown) => copies[(shorthand as { $profile: string }).$profile]!;
    // Recipe 1's record, rewritten with its Profile edited, as the server writes one, and the Workflow once it was applied again.
    const posted = steps.recordProfileEdited!.exchanges[0]!.request.body as Record_[];
    const record = copy((posted.find((recipe) => recipe.id === "1")!.workflow as Record_).profile);
    const workflow = copy((steps.reapplyEdited!.after.find(({ request }) => request.path === "/workflow")!.response.body as Record_).profile);
    const firstStep = (profile: Record_) => (profile.steps as Record_[])[0]!;
    expect(Object.keys(firstStep(record))).not.toEqual(Object.keys(firstStep(workflow)));
    expect(dye2Fingerprint(record)).not.toBeNull();
    expect(dye2Fingerprint(record)).toBe(dye2Fingerprint(workflow));
  });
});
