import { createHash, randomBytes } from "node:crypto";

// Bearer secrets: session cookies and Machine tokens. Each is 256 random bits,
// so a fast hash is enough to keep a database leak from being replayed; only
// the hash is stored.

export function newSecret(): string {
  return randomBytes(32).toString("base64url");
}

export function hashSecret(secret: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(createHash("sha256").update(secret).digest());
}
