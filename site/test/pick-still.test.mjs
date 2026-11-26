// Which file the site shows for one of the generator's images (src/pick-still.mjs).
//
//   npm test -w site
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { byFile, pickStill } from "../src/pick-still.mjs";

const generated = byFile({ "/generated/overview-light.png": "generated overview" });
const committed = byFile({ "../../../docs/images/overview-light.png": "committed overview", "../../../docs/images/shot-light.png": "committed shot" });

describe("a still on the site", () => {
    test("is the generated image where there is one", () => {
        assert.equal(pickStill("overview-light.png", { generated, committed, required: false }), "generated overview");
        assert.equal(pickStill("overview-light.png", { generated, committed, required: true }), "generated overview");
    });

    test("is the README's committed copy in a build without generated images", () => {
        assert.equal(pickStill("shot-light.png", { generated, committed, required: false }), "committed shot");
    });

    test("is none in that build when the README commits no copy", () => {
        assert.equal(pickStill("shots-light.png", { generated, committed, required: false }), undefined);
    });

    test("fails the deploy's build when the generator did not make it", () => {
        assert.throws(() => pickStill("shot-light.png", { generated, committed, required: true }), /shot-light\.png is not among the generated images/);
    });
});
