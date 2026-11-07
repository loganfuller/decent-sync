import { BlockList, isIP } from "node:net";

// Which addresses a Client ID Metadata Document may be fetched from: only
// public ones, so an app's client id can't make the server reach into the
// network it runs on, such as a database, a cloud's metadata service or a
// router (ADR-0027). The pure module, tested in
// server/test/public-addresses.test.ts.

/** IPv4 ranges that reach no public host: IANA's special-purpose registry, less what is globally reachable. */
const SPECIAL_IPV4: [string, number][] = [
  ["0.0.0.0", 8], // this network
  ["10.0.0.0", 8], // private
  ["100.64.0.0", 10], // shared address space (carrier-grade NAT)
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local, cloud metadata services among them
  ["172.16.0.0", 12], // private
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // documentation
  ["192.88.99.0", 24], // 6to4 relay anycast, deprecated
  ["192.168.0.0", 16], // private
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // documentation
  ["203.0.113.0", 24], // documentation
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, and the broadcast address
];

/**
 * IPv6 ranges inside global unicast (2000::/3) that reach no public host, or
 * another address the check could not see: Teredo, ORCHID and the rest of
 * IETF's protocol assignments, documentation, and 6to4, which embeds an IPv4
 * address. Everything outside 2000::/3 is refused anyway: loopback, link-local,
 * unique local, multicast, IPv4-mapped and NAT64 among them.
 */
const SPECIAL_IPV6: [string, number][] = [
  ["2001::", 23], // IETF protocol assignments
  ["2001:db8::", 32], // documentation
  ["2002::", 16], // 6to4
  ["3fff::", 20], // documentation
];

const notPublic = new BlockList();
for (const [address, prefix] of SPECIAL_IPV4) notPublic.addSubnet(address, prefix, "ipv4");
for (const [address, prefix] of SPECIAL_IPV6) notPublic.addSubnet(address, prefix, "ipv6");

const globalUnicast = new BlockList();
globalUnicast.addSubnet("2000::", 3, "ipv6");

/** Whether an IP address is a public one, which a Client ID Metadata Document may be fetched from. */
export function isPublicAddress(address: string): boolean {
  const unbracketed = address.replace(/^\[(.*)\]$/, "$1");
  switch (isIP(unbracketed)) {
    case 4:
      return !notPublic.check(unbracketed, "ipv4");
    case 6:
      return globalUnicast.check(unbracketed, "ipv6") && !notPublic.check(unbracketed, "ipv6");
    default:
      return false;
  }
}

const loopback = new BlockList();
loopback.addSubnet("127.0.0.0", 8, "ipv4");
loopback.addAddress("::1", "ipv6");

/** Whether an IP address is a loopback one, which a test may serve a Client ID Metadata Document from (TEST_LOOPBACK_CLIENT_METADATA). */
export function isLoopbackAddress(address: string): boolean {
  const unbracketed = address.replace(/^\[(.*)\]$/, "$1");
  const family = isIP(unbracketed);
  return family !== 0 && loopback.check(unbracketed, family === 4 ? "ipv4" : "ipv6");
}
