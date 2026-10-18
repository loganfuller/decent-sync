import type { IncomingMessage } from "node:http";
import { isIP } from "node:net";

/**
 * The address a sync connection came from, by its upgrade request. With no
 * `header`, CLIENT_ADDRESS_HEADER unset, it is the socket's: behind a reverse
 * proxy, the proxy's. With one, it is that header's last comma-separated
 * entry, the one the nearest proxy appended to X-Forwarded-For or the whole
 * value of a single-valued header, if it is an IPv4 or IPv6 address with no
 * zone id, and otherwise the socket's. Only such an address is taken from a
 * header: `isIP` accepts a zone id of any length, which no client across a
 * network has, so no other string a client sent is recorded or logged.
 */
export function clientAddress(request: IncomingMessage, header: string | undefined): string {
  const socketAddress = request.socket.remoteAddress ?? "an unknown address";
  if (header === undefined) return socketAddress;
  // A header sent more than once counts as one value with its lines joined by commas.
  const entry = request.headersDistinct[header]?.at(-1)?.split(",").at(-1)?.trim();
  return entry !== undefined && !entry.includes("%") && isIP(entry) !== 0 ? entry : socketAddress;
}
