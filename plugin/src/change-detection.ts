// Whether a collection changed since the plugin last queued it, decided from
// what Decaid's API answered. Pure, so module tests can drive it without a
// tablet; plugin/src/collections.ts does the reading and sending.

/** What the plugin last queued for a collection. */
export type Fingerprint =
  | { available: false }
  /** Its ETag where Decaid sends one, otherwise a hash of its content. */
  | { available: true; etag: string | null; hash: string | null };

/** What one read of a collection from Decaid's API gave. */
export type Reading =
  /** The read failed, or had nothing to report, such as a DYE2 key never written. */
  | { kind: "unavailable" }
  /** Decaid answered 304: the ETag sent with If-None-Match is still current. */
  | { kind: "notModified" }
  | { kind: "value"; value: unknown; etag: string | null };

export interface Decision {
  /** Whether to send the collection now. */
  send: boolean;
  /** What the next read is compared with. */
  next: Fingerprint | undefined;
}

/** The ETag to send as If-None-Match: the one Decaid gave with what was last queued, if any. */
export function ifNoneMatch(last: Fingerprint | undefined): string | null {
  return last?.available ? last.etag : null;
}

/**
 * Whether to send what a read gave, and what to compare the next read with.
 * A collection is sent when it changed since it was last queued: it became
 * available or unavailable, or its ETag differs, or, without one, its
 * content. With `full`, as on every welcome, it is sent whether or not it
 * changed; a full read sends no If-None-Match, so it never gets a 304.
 */
export function decide(last: Fingerprint | undefined, reading: Reading, full: boolean): Decision {
  switch (reading.kind) {
    case "notModified":
      return { send: false, next: last };
    case "unavailable":
      return { send: full || last?.available !== false, next: { available: false } };
    case "value": {
      const next: Fingerprint =
        reading.etag !== null
          ? { available: true, etag: reading.etag, hash: null }
          : { available: true, etag: null, hash: contentHash(JSON.stringify(reading.value)) };
      return { send: full || !sameFingerprint(last, next), next };
    }
  }
}

/**
 * The paired devices in Decaid's device inventory (`GET /devices`): those
 * connected or connecting, and those Decaid remembers, left out only when
 * merely discovered nearby. Discovered devices come and go, and may belong
 * to another Machine at the same Location, so leaving them out keeps them
 * from changing the collection. Null if the inventory is not a list.
 */
export function pairedDevices(inventory: unknown): unknown[] | null {
  if (!Array.isArray(inventory)) return null;
  return inventory.filter((device) => !(typeof device === "object" && device !== null && (device as { state?: unknown }).state === "discovered"));
}

/**
 * A 64-bit hash of a text (cyrb53's mixing, both halves kept) with its
 * length. It only tells whether content changed, so it need not resist
 * tampering; a collision would at worst delay a change until the next
 * welcome sends everything again.
 */
export function contentHash(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return `${text.length}:${hex(h2)}${hex(h1)}`;
}

function sameFingerprint(a: Fingerprint | undefined, b: Fingerprint): boolean {
  if (!a?.available || !b.available) return a?.available === b.available;
  return a.etag === b.etag && a.hash === b.hash;
}

function hex(half: number): string {
  return (half >>> 0).toString(16).padStart(8, "0");
}
