import { describe, expect, it } from "vitest";
import { type TokenMachine, isRealSerial, realHardware, resolveIdentity } from "../src/sync/identity.js";

// Identity resolution through its own interface: every outcome a `hello` can
// have for its token's Machine (ADR-0004, ADR-0015).

const de1Pro = { model: "DE1Pro", serial: "10001", firmware: "1333" };
const alias = "00:00:5E:00:53:01";
const otherAlias = "00:00:5E:00:53:02";

const unbound: TokenMachine = { binding: null, aliases: [], dismissed: [] };
const bound: TokenMachine = { binding: { model: "DE1Pro", serial: "10001" }, aliases: [alias], dismissed: [] };

describe("resolveIdentity", () => {
  describe("identified", () => {
    it("binds an unbound Machine to the first real hardware it reports, and remembers the connection id", () => {
      expect(resolveIdentity({ machine: de1Pro, connectionId: alias }, unbound, false)).toEqual({
        kind: "identified",
        bind: true,
        recognisedBy: "hardware",
        rememberAlias: true,
      });
    });

    it("binds an Unidentified Machine once it reports a real serial", () => {
      const unidentified: TokenMachine = { binding: null, aliases: [alias], dismissed: [] };
      expect(resolveIdentity({ machine: de1Pro, connectionId: alias }, unidentified, false)).toMatchObject({
        kind: "identified",
        bind: true,
        rememberAlias: false,
      });
    });

    it("recognises the hardware the token is bound to", () => {
      expect(resolveIdentity({ machine: de1Pro, connectionId: alias }, bound, false)).toEqual({
        kind: "identified",
        bind: false,
        recognisedBy: "hardware",
        rememberAlias: false,
      });
    });

    it("keeps the same Machine for a new tablet on the same hardware, and remembers its connection id", () => {
      expect(resolveIdentity({ machine: de1Pro, connectionId: otherAlias }, bound, false)).toMatchObject({
        kind: "identified",
        rememberAlias: true,
      });
      expect(resolveIdentity({ machine: de1Pro }, bound, false)).toMatchObject({ kind: "identified", rememberAlias: false });
    });

    it("ignores whitespace around the model, serial and connection id", () => {
      const spaced = { machine: { model: " DE1Pro ", serial: "10001\n" }, connectionId: ` ${alias} ` };
      expect(resolveIdentity(spaced, bound, false)).toMatchObject({ kind: "identified", recognisedBy: "hardware", rememberAlias: false });
    });

    it("recognises a bound Machine by a known alias when no machine is connected to its tablet", () => {
      for (const machine of [undefined, null]) {
        expect(resolveIdentity({ machine, connectionId: alias }, bound, false)).toEqual({
          kind: "identified",
          bind: false,
          recognisedBy: "alias",
          rememberAlias: false,
        });
      }
    });

    it("recognises a bound Machine reporting no real serial by a known alias, as a Machine identified by hand does", () => {
      for (const serial of ["0", "", " "]) {
        expect(resolveIdentity({ machine: { model: "DE1", serial }, connectionId: alias }, bound, false)).toMatchObject({
          kind: "identified",
          recognisedBy: "alias",
        });
      }
    });
  });

  describe("hardware not yet reported", () => {
    it("is a bound Machine's tablet without a machine, from a connection id that is not a known alias", () => {
      for (const connectionId of [otherAlias, null, undefined, ""]) {
        expect(resolveIdentity({ machine: null, connectionId }, bound, false)).toEqual({ kind: "hardwareNotReported" });
      }
    });

    it("is an unbound Machine's tablet without a machine, whatever its connection id", () => {
      const unidentified: TokenMachine = { binding: null, aliases: [alias], dismissed: [] };
      expect(resolveIdentity({ connectionId: alias }, unidentified, false)).toEqual({ kind: "hardwareNotReported" });
      expect(resolveIdentity({}, unbound, false)).toEqual({ kind: "hardwareNotReported" });
    });

    it("is never unidentified or a mismatch, even for a Machine with dismissed hardware", () => {
      const dismissing: TokenMachine = { ...bound, dismissed: [{ model: "DE1Pro", serial: "10002" }] };
      expect(resolveIdentity({ connectionId: otherAlias }, dismissing, true)).toEqual({ kind: "hardwareNotReported" });
    });
  });

  describe("unidentified", () => {
    it("is a machine reporting serial 0 or none, which never binds", () => {
      for (const machine of [
        { model: "DE1", serial: "0" },
        { model: "DE1", serial: "" },
        { model: "DE1", serial: " 0 " },
        { model: "", serial: "10001" },
      ]) {
        expect(resolveIdentity({ machine, connectionId: alias }, unbound, false)).toEqual({ kind: "unidentified", rememberAlias: true });
      }
    });

    it("remembers no connection id when there is none", () => {
      expect(resolveIdentity({ machine: { model: "DE1", serial: "0" } }, unbound, false)).toEqual({
        kind: "unidentified",
        rememberAlias: false,
      });
    });

    it("is a bound Machine reporting serial 0 from a connection id that is not a known alias, which is not remembered", () => {
      expect(resolveIdentity({ machine: { model: "DE1", serial: "0" }, connectionId: otherAlias }, bound, false)).toEqual({
        kind: "unidentified",
        rememberAlias: false,
      });
    });

    it("is never a mismatch, whatever model it reports", () => {
      expect(resolveIdentity({ machine: { model: "Bengle", serial: "0" }, connectionId: otherAlias }, bound, true)).toMatchObject({
        kind: "unidentified",
      });
    });
  });

  describe("mismatch", () => {
    it("is real hardware other than the hardware the token is bound to", () => {
      expect(resolveIdentity({ machine: { model: "DE1Pro", serial: "10002" }, connectionId: alias }, bound, false)).toEqual({
        kind: "mismatch",
        hardware: { model: "DE1Pro", serial: "10002" },
        anotherMachineHasIt: false,
      });
    });

    it("is the same serial on another model, which is other hardware", () => {
      expect(resolveIdentity({ machine: { model: "DE1XL", serial: "10001" }, connectionId: alias }, bound, false)).toEqual({
        kind: "mismatch",
        hardware: { model: "DE1XL", serial: "10001" },
        anotherMachineHasIt: false,
      });
    });

    it("says when another Machine has the hardware", () => {
      expect(resolveIdentity({ machine: { model: "DE1Pro", serial: "10002" } }, bound, true)).toMatchObject({
        kind: "mismatch",
        anotherMachineHasIt: true,
      });
    });

    it("is an unbound Machine reporting hardware another Machine has, which it cannot bind", () => {
      expect(resolveIdentity({ machine: de1Pro, connectionId: alias }, unbound, true)).toEqual({
        kind: "mismatch",
        hardware: { model: "DE1Pro", serial: "10001" },
        anotherMachineHasIt: true,
      });
    });
  });

  describe("rejected", () => {
    const dismissing: TokenMachine = { ...bound, dismissed: [{ model: "DE1Pro", serial: "10002" }] };

    it("is hardware an Admin dismissed for this token", () => {
      expect(resolveIdentity({ machine: { model: "DE1Pro", serial: "10002" }, connectionId: alias }, dismissing, false)).toEqual({
        kind: "rejected",
        hardware: { model: "DE1Pro", serial: "10002" },
      });
    });

    it("leaves the token's own hardware and other mismatches alone", () => {
      expect(resolveIdentity({ machine: de1Pro }, dismissing, false)).toMatchObject({ kind: "identified" });
      expect(resolveIdentity({ machine: { model: "DE1XL", serial: "10002" } }, dismissing, false)).toMatchObject({ kind: "mismatch" });
    });
  });
});

describe("realHardware", () => {
  it("is the trimmed model and serial when both name real hardware", () => {
    expect(realHardware({ model: " DE1Pro", serial: "10001 ", firmware: "1333" })).toEqual({ model: "DE1Pro", serial: "10001" });
    expect(realHardware({ model: "DE1", serial: "0" })).toBeNull();
    expect(realHardware(null)).toBeNull();
  });

  it("treats serial 0 and an empty serial as no identity", () => {
    expect(["0", "", "  ", " 0"].map(isRealSerial)).toEqual([false, false, false, false]);
    expect(["10001", "00", "A1"].map(isRealSerial)).toEqual([true, true, true]);
  });
});
