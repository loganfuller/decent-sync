// The version selector's reading of versions.json and its addresses.
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { addressIn, listed, minorOf, pathIn } from "../src/versions.mjs";

describe("the version selector's list and addresses", () => {
    test("names a version's minor", () => {
        assert.equal(minorOf("1.13.2"), "v1.13");
        assert.throws(() => minorOf("1.13"), /is not a version X\.Y\.Z/);
    });

    test("lists the deployed minors newest first, with the one being read", () => {
        assert.deepEqual(listed({ latest: "v1.14", versions: ["v1.14", "v1.13"] }, "v1.13"), { latest: "v1.14", versions: ["v1.14", "v1.13"] });
        assert.deepEqual(listed({ latest: "v1.10", versions: ["v1.9", "v1.10"] }, "v1.9").versions, ["v1.10", "v1.9"]);
        // A build the deploy has not listed, such as a local one, still shows its own.
        assert.deepEqual(listed({ latest: "v1.14", versions: ["v1.14"] }, "v1.15"), { latest: "v1.14", versions: ["v1.15", "v1.14"] });
    });

    test("lists only the minor being read, as the latest, without a versions.json", () => {
        for (const manifest of [null, {}, "not json", { latest: 3, versions: "v1.14" }]) {
            assert.deepEqual(listed(manifest, "v1.13"), { latest: "v1.13", versions: ["v1.13"] });
        }
        assert.deepEqual(listed({ latest: "v1.14", versions: ["v1.14", "latest", 2] }, "v1.13").versions, ["v1.14", "v1.13"]);
    });

    test("finds the page being read within its build", () => {
        assert.equal(pathIn("/decent-sync/v1.13/guide/shots/", "/decent-sync/v1.13"), "guide/shots/");
        assert.equal(pathIn("/decent-sync/v1.13/", "/decent-sync/v1.13"), "");
        assert.equal(pathIn("/decent-sync/guide/shots/", "/decent-sync"), "guide/shots/");
        // GitHub Pages' page for an address that names nothing, outside the build's path.
        assert.equal(pathIn("/decent-sync/v1.13x/guide/", "/decent-sync/v1.13"), "");
    });

    test("addresses the latest minor at the root and every other at its own path", () => {
        assert.equal(addressIn("v1.14", "v1.14", "/decent-sync", "guide/shots/"), "/decent-sync/guide/shots/");
        assert.equal(addressIn("v1.13", "v1.14", "/decent-sync", "guide/shots/"), "/decent-sync/v1.13/guide/shots/");
        assert.equal(addressIn("v1.13", "v1.14", "/decent-sync", ""), "/decent-sync/v1.13/");
    });
});
