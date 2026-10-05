import { type Hardware, type MachineHardware, realHardware, sameHardware } from "@decent-sync/protocol";

export { type Hardware, isRealSerial, realHardware, sameHardware } from "@decent-sync/protocol";

// Identity resolution (ADR-0004, ADR-0015): what a `hello` means for the
// token's Machine. Decided once per connection, at `hello`, and never changed
// mid-session.
//
// A Machine's identity is its model and serial together, so the same serial
// on another model is other hardware. A serial of "0" or "" is no identity:
// older DE1s report "0" unless Decaid can resolve their serial. Connection
// ids (Decaid's preferredMachineId) are remembered as aliases once a session
// shows they belong to the Machine, and recognise it when its hardware cannot.

/** What the server knows about the token's Machine when its `hello` arrives. */
export interface TokenMachine {
  /** The hardware the token is bound to, or null until a connection reports real hardware. */
  binding: Hardware | null;
  /** Connection ids already shown to belong to this Machine. */
  aliases: readonly string[];
  /** Hardware an Admin dismissed for this Machine, surviving token rotation. */
  dismissed: readonly Hardware[];
}

export type Identity =
  /**
   * The Machine's own hardware: it reported the hardware its token is bound
   * to (`bind` when this is the first time), or reported no real serial or no
   * hardware from a connection id known to be its own.
   */
  | { kind: "identified"; bind: boolean; recognisedBy: "hardware" | "alias"; rememberAlias: boolean }
  /** No machine is connected to the tablet yet, and its connection id is not a known alias. */
  | { kind: "hardwareNotReported" }
  /**
   * The machine reports no real serial. An unbound Machine is recognised by
   * its token, and its connection id is remembered; a bound one reached from
   * an unknown connection id cannot be told apart from other hardware.
   */
  | { kind: "unidentified"; rememberAlias: boolean }
  /**
   * Real hardware other than the hardware the token is bound to, or hardware
   * another Machine already has. What the session sends belongs to that
   * hardware: to the Machine that has it, otherwise to a Pending Machine.
   */
  | { kind: "mismatch"; hardware: Hardware; anotherMachineHasIt: boolean }
  /** Hardware an Admin dismissed for the token's Machine. */
  | { kind: "rejected"; hardware: Hardware };

/** Who reported a record: the Machine whose token its connection used, and the identity that connection was given at hello. */
export interface Reporter {
  machineId: string;
  identity: Identity;
}

export interface Reported {
  /** The hardware the `hello` reports; absent or null while no machine is connected. */
  machine?: MachineHardware | null;
  connectionId?: string | null;
}

/**
 * Decides who the tablet is. `anotherMachineHasIt` says whether a Machine
 * other than the token's is bound to the reported model and serial.
 */
export function resolveIdentity(reported: Reported, machine: TokenMachine, anotherMachineHasIt: boolean): Identity {
  const connectionId = reported.connectionId?.trim() || null;
  const knownAlias = connectionId !== null && machine.aliases.includes(connectionId);
  const hardware = realHardware(reported.machine);

  if (!reported.machine || !hardware) {
    // A bound Machine is recognised by a connection id known to be its own.
    if (machine.binding && knownAlias) return { kind: "identified", bind: false, recognisedBy: "alias", rememberAlias: false };
    if (!reported.machine) return { kind: "hardwareNotReported" };
    // An unbound Machine has nothing but its token and connection id to be known by.
    return { kind: "unidentified", rememberAlias: machine.binding === null && connectionId !== null };
  }

  if (machine.binding && sameHardware(machine.binding, hardware)) {
    return { kind: "identified", bind: false, recognisedBy: "hardware", rememberAlias: connectionId !== null && !knownAlias };
  }
  if (machine.dismissed.some((dismissed) => sameHardware(dismissed, hardware))) return { kind: "rejected", hardware };
  if (machine.binding || anotherMachineHasIt) return { kind: "mismatch", hardware, anotherMachineHasIt };
  return { kind: "identified", bind: true, recognisedBy: "hardware", rememberAlias: connectionId !== null && !knownAlias };
}

