import { describe, expect, it } from "vitest";
import { PROTOCOL_VERSION } from "@decent-sync/protocol";

describe("protocol", () => {
  it("starts at protocol version 1", () => {
    expect(PROTOCOL_VERSION).toBe(1);
  });
});
