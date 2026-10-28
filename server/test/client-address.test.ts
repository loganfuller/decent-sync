import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { AdminApi, type TakeoverView } from "./support/admin-api.js";
import { RawConnection, helloWith } from "./support/simulated-tablet.js";
import { type TestServer, startTestServer } from "./support/test-server.js";

// Seam 1 for ticket #201: with CLIENT_ADDRESS_HEADER naming a header a reverse
// proxy sets, a sync connection's address is that header's last entry when it
// is an IP address, and the socket's otherwise; unset, it is always the
// socket's. Raw connections send the headers a proxy would add, since the
// plugin cannot send any, to instances on one database configured each way.
// A Machine's view shows a connection's address only in its takeover, so each
// case connects two tablets with one token: the takeover holds the stored
// address of the first tablet's connection, and the second's.

const SOCKET_ADDRESS = "127.0.0.1";

describe("Client addresses", () => {
  let unset: TestServer;
  let blank: TestServer;
  let realIp: TestServer;
  let forwarded: TestServer;
  let api: AdminApi;
  const connections: RawConnection[] = [];

  beforeAll(async () => {
    unset = await startTestServer();
    const configured = (header: string) => startTestServer({ env: { CLIENT_ADDRESS_HEADER: header }, sharing: unset });
    [blank, realIp, forwarded] = await Promise.all([configured(" "), configured("X-Real-IP"), configured("X-Forwarded-For")]);
    api = await AdminApi.setUp(unset.url);
  });
  afterEach(async () => {
    await Promise.all(connections.splice(0).map((raw) => raw.terminate()));
  });
  afterAll(async () => {
    await unset?.stop();
  });

  /**
   * Connects two tablets with one new Machine's token to an instance, the
   * first with `first`'s headers on its upgrade request and the second, taking
   * the Machine over, with `second`'s, and resolves with the takeover.
   */
  async function takeover(
    instance: TestServer,
    first: Record<string, string>,
    second: Record<string, string> = {},
  ): Promise<{ name: string; tabletIds: [string, string]; takeover: TakeoverView }> {
    const { machine, token } = await api.createMachine(`Address ${randomUUID()}`);
    const tabletIds: [string, string] = [randomUUID(), randomUUID()];
    for (const [index, headers] of [first, second].entries()) {
      connections.push(await RawConnection.welcomed(instance.url, helloWith(token, { tabletId: tabletIds[index], machine: null }), 300, headers));
    }
    const viewed = await api.waitForMachine(machine.name, (view) => view.takeover !== null);
    return { name: machine.name, tabletIds, takeover: viewed.takeover! };
  }

  /** The addresses the takeover recorded for the first tablet's connection and the second's. */
  const addresses = ({ takeover }: { takeover: TakeoverView }) => [takeover.replaced.remoteAddress, takeover.replacement.remoteAddress];

  it("records the socket's address and reads no header while CLIENT_ADDRESS_HEADER is unset", async () => {
    const recorded = await takeover(unset, { "X-Forwarded-For": "203.0.113.7", "X-Real-IP": "203.0.113.8" });
    expect(addresses(recorded)).toEqual([SOCKET_ADDRESS, SOCKET_ADDRESS]);
    await expect.poll(() => unset.output()).toContain(`Machine ${recorded.name} connected from ${SOCKET_ADDRESS}:`);
  });

  it("treats a blank CLIENT_ADDRESS_HEADER as unset", async () => {
    const recorded = await takeover(blank, { "X-Forwarded-For": "203.0.113.7" });
    expect(addresses(recorded)).toEqual([SOCKET_ADDRESS, SOCKET_ADDRESS]);
  });

  it("records the address in the header named, matched whatever its case, and logs it", async () => {
    const recorded = await takeover(realIp, { "X-REAL-IP": "203.0.113.7" }, { "x-real-ip": "2001:db8::7" });
    expect(addresses(recorded)).toEqual(["203.0.113.7", "2001:db8::7"]);
    const [first, second] = recorded.tabletIds;
    await expect.poll(() => realIp.output()).toContain(`Machine ${recorded.name} connected from 203.0.113.7:`);
    await expect.poll(() => realIp.output()).toContain(
      `Machine ${recorded.name} was taken over by tablet ${second} from 2001:db8::7, from tablet ${first} at 203.0.113.7:`,
    );
  });

  it("records the last entry of X-Forwarded-For, the one the nearest proxy appended, IPv4 or IPv6", async () => {
    const recorded = await takeover(
      forwarded,
      { "X-Forwarded-For": "198.51.100.1, 203.0.113.7" },
      { "X-Forwarded-For": "198.51.100.1,2001:db8::1:7 " },
    );
    expect(addresses(recorded)).toEqual(["203.0.113.7", "2001:db8::1:7"]);
  });

  it("records the socket's address when the header is missing, or its last entry is not an IP address without a zone id", async () => {
    expect(addresses(await takeover(realIp, {}, { "X-Forwarded-For": "203.0.113.7" }))).toEqual([SOCKET_ADDRESS, SOCKET_ADDRESS]);
    expect(addresses(await takeover(realIp, { "X-Real-IP": "not-an-ip" }, { "X-Real-IP": "203.0.113.7:1234" }))).toEqual([
      SOCKET_ADDRESS,
      SOCKET_ADDRESS,
    ]);
    expect(addresses(await takeover(forwarded, { "X-Forwarded-For": "203.0.113.7, " }, { "X-Forwarded-For": "[2001:db8::7]" }))).toEqual([
      SOCKET_ADDRESS,
      SOCKET_ADDRESS,
    ]);
    // An IPv6 address with a zone id, which isIP accepts, however long.
    expect(addresses(await takeover(forwarded, { "X-Forwarded-For": `fe80::1%${"x".repeat(1000)}` }))).toEqual([SOCKET_ADDRESS, SOCKET_ADDRESS]);
  });
});
