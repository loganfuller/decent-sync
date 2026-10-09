import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { SimulatedTablet } from "./support/simulated-tablet.js";

// The simulated tablet's Workflow writes against those recorded on Decaid
// v0.8.7's Linux release (fixtures/decaid/workflow-writes-v0.8.7/): each
// recorded request is sent to a simulated tablet whose Workflow starts as
// that one's did, and must be answered the same, field for field. Each
// recording disconnected its machine before its last requests, and so does
// this.

interface Exchange {
  request: { method: "GET" | "PUT"; path: string; body?: unknown };
  response: { status: number; body: unknown };
}

const fixtures = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "fixtures/decaid/workflow-writes-v0.8.7");
const read = (file: string) => JSON.parse(fs.readFileSync(path.join(fixtures, file), "utf8")) as Exchange[];

describe("The simulated tablet's Workflow writes", () => {
  const tablets: SimulatedTablet[] = [];
  afterAll(() => Promise.all(tablets.map((tablet) => tablet.unload())));

  /** The answers a simulated tablet gives the recorded requests, its machine disconnected before the last `disconnected` of them. */
  async function replay(exchanges: Exchange[], disconnected: number): Promise<Exchange["response"][]> {
    // No settings: the plugin does not connect, and only Decaid's API is used.
    const tablet = SimulatedTablet.load({ settings: {}, api: { "/workflow": exchanges[0]!.response.body } });
    tablets.push(tablet);
    const answers: Exchange["response"][] = [];
    for (const [index, { request }] of exchanges.entries()) {
      if (index === exchanges.length - disconnected) tablet.machineConnected = false;
      answers.push(await tablet.callApi(request.method, request.path, request.body));
    }
    return answers;
  }

  it("answer as Decaid v0.8.7 answered them, field for field, refusals and a missing machine included", async () => {
    const exchanges = read("workflow-writes.json");
    expect(await replay(exchanges, 6)).toEqual(exchanges.map((exchange) => exchange.response));
  });

  it("clear the fields of the Workflow's context merged in as null, and read the others as Decaid v0.8.7 did, with or without a machine", async () => {
    const exchanges = read("workflow-context-writes.json");
    expect(await replay(exchanges, 2)).toEqual(exchanges.map((exchange) => exchange.response));
  });
});
