import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { SimulatedTablet } from "./support/simulated-tablet.js";

// The simulated tablet's Workflow writes against those recorded on Decaid
// v0.8.7's Linux release (fixtures/decaid/workflow-writes-v0.8.7/): each
// recorded request is sent to a simulated tablet whose Workflow starts as
// that one's did, and must be answered the same, field for field. The
// recording disconnected its machine before the last six requests, and so
// does this.

interface Exchange {
  request: { method: "GET" | "PUT"; path: string; body?: unknown };
  response: { status: number; body: unknown };
}

const fixture = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "fixtures/decaid/workflow-writes-v0.8.7/workflow-writes.json");
const exchanges = JSON.parse(fs.readFileSync(fixture, "utf8")) as Exchange[];
/** The requests made once the machine was disconnected. */
const DISCONNECTED = 6;

describe("The simulated tablet's Workflow writes", () => {
  // No settings: the plugin does not connect, and only Decaid's API is used.
  const tablet = SimulatedTablet.load({ settings: {}, api: { "/workflow": exchanges[0]!.response.body } });
  afterAll(() => tablet.unload());

  it("answer as Decaid v0.8.7 answered them, field for field, refusals and a missing machine included", async () => {
    const answers: Exchange["response"][] = [];
    for (const [index, { request }] of exchanges.entries()) {
      if (index === exchanges.length - DISCONNECTED) tablet.machineConnected = false;
      answers.push(await tablet.callApi(request.method, request.path, request.body));
    }
    expect(answers).toEqual(exchanges.map((exchange) => exchange.response));
  });
});
