import { describe, expect, it } from "vitest";
import { isLoopbackAddress, isPublicAddress } from "../src/connected-apps/public-addresses.js";

// Which addresses an app's Client ID Metadata Document may be fetched from
// (ADR-0027), through the pure module's interface: only public ones, so a
// client id can't reach into the network the server runs on. Seam 1 can't
// reach these without public hosts.

describe("public addresses", () => {
  it.each([
    "8.8.8.8",
    "1.1.1.1",
    "104.18.32.47",
    "100.63.255.255",
    "100.128.0.0",
    "172.15.255.255",
    "172.32.0.0",
    "192.0.1.255",
    "192.169.0.0",
    "198.17.255.255",
    "198.20.0.0",
    "223.255.255.255",
  ])("counts %s as public", (address) => {
    expect(isPublicAddress(address)).toBe(true);
  });

  it.each([
    ["0.0.0.0", "this network"],
    ["10.0.0.1", "private"],
    ["100.64.0.1", "carrier-grade NAT"],
    ["127.0.0.1", "loopback"],
    ["127.255.255.254", "loopback"],
    ["169.254.169.254", "a cloud's metadata service"],
    ["172.16.0.1", "private"],
    ["172.31.255.255", "private"],
    ["192.0.0.8", "IETF protocol assignments"],
    ["192.0.2.1", "documentation"],
    ["192.88.99.1", "6to4 relay anycast"],
    ["192.168.20.149", "private"],
    ["198.18.0.1", "benchmarking"],
    ["198.51.100.7", "documentation"],
    ["203.0.113.7", "documentation"],
    ["224.0.0.251", "multicast"],
    ["240.0.0.1", "reserved"],
    ["255.255.255.255", "broadcast"],
  ])("refuses %s, %s", (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  it.each(["2606:4700:4700::1111", "2001:4860:4860::8888", "2a00:1450:4001:80b::200e", "[2606:4700:4700::1111]"])("counts %s as public", (address) => {
    expect(isPublicAddress(address)).toBe(true);
  });

  it.each([
    ["::", "unspecified"],
    ["::1", "loopback"],
    ["[::1]", "loopback, bracketed as a URL's host is"],
    ["::ffff:127.0.0.1", "IPv4-mapped"],
    ["::ffff:8.8.8.8", "IPv4-mapped, whose IPv4 address the check would not see"],
    ["64:ff9b::a00:1", "NAT64"],
    ["fc00::1", "unique local"],
    ["fd12:3456:789a::1", "unique local"],
    ["fe80::1", "link-local"],
    ["fec0::1", "site-local"],
    ["ff02::1", "multicast"],
    ["2001::1", "Teredo"],
    ["2001:db8::1", "documentation"],
    ["2002:c0a8:0101::1", "6to4, embedding 192.168.1.1"],
    ["3fff::1", "documentation"],
  ])("refuses %s, %s", (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  it("refuses what is not an address, such as a host name", () => {
    expect(isPublicAddress("example.com")).toBe(false);
    expect(isPublicAddress("")).toBe(false);
  });

  it("knows loopback addresses, which a test may serve one from", () => {
    expect(["127.0.0.1", "127.1.2.3", "::1", "[::1]"].map(isLoopbackAddress)).toEqual([true, true, true, true]);
    expect(["10.0.0.1", "8.8.8.8", "fe80::1", "localhost"].map(isLoopbackAddress)).toEqual([false, false, false, false]);
  });
});
