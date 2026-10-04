import type { MachineHardware } from "@decent-sync/protocol";

// Identity resolution (ADR-0004, ADR-0015): what a `hello` means for the
// token's Machine. Decided once per connection, at `hello`, and never changed
// mid-session. Connection id aliases, Unidentified Machines and mismatches
// are recorded by ticket #6; until then those connections are accepted for
// the token's Machine without changing its binding.

export type Identity =
  /** The first real hardware reported with this Machine's token: bind it. */
  | { kind: "bind"; model: string; serial: string }
  /** The reported hardware is the hardware the token is bound to. */
  | { kind: "identified" }
  /** No machine is connected to the tablet yet, so no hardware was reported. */
  | { kind: "hardwareNotReported" }
  /** The machine reports no real serial ("0" or empty). */
  | { kind: "unidentified" }
  /** Real hardware other than the hardware the token is bound to. */
  | { kind: "mismatch"; model: string; serial: string };

export function resolveIdentity(
  reported: MachineHardware | null | undefined,
  bound: { model: string | null; serial: string | null },
): Identity {
  if (!reported) return { kind: "hardwareNotReported" };
  const model = reported.model.trim();
  const serial = reported.serial.trim();
  if (serial === "" || serial === "0" || model === "") return { kind: "unidentified" };
  if (bound.model === null || bound.serial === null) return { kind: "bind", model, serial };
  if (bound.model === model && bound.serial === serial) return { kind: "identified" };
  return { kind: "mismatch", model, serial };
}
