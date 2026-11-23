// The values of a Tablet's plugins' settings (`pluginSettings`, ADR-0034)
// go to Admins alone: a plugin's settings may name an account on another
// service. Everyone else who reads the Machine is shown which settings are
// set and that they changed, not what to.

import { isSecretState } from "@decent-sync/protocol";
import type { Scope } from "../accounts/scope.js";

/** What stands in for a setting's value to a reader who is no Admin. */
export const HIDDEN_VALUE = { hidden: true } as const;

/** Whether the reader is shown the values of plugins' settings: an Admin is. */
export function seesPluginSettings(scope: Scope): boolean {
  return scope.kind === "everything";
}

/** One setting's value as the reader may see it: whole to an Admin; to anyone else hidden, but for whether a secret is set, and null for none. */
export function shownSetting(value: unknown, scope: Scope): unknown {
  if (seesPluginSettings(scope) || value === null || value === undefined || isSecretState(value)) return value ?? null;
  return HIDDEN_VALUE;
}

/** The `pluginSettings` collection's value as the reader may see it: each plugin's settings by name, their values hidden from anyone but an Admin. */
export function shownPluginSettings(value: unknown, scope: Scope): unknown {
  if (seesPluginSettings(scope) || !isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([pluginId, settings]) => [pluginId, isRecord(settings) ? Object.fromEntries(Object.entries(settings).map(([name, held]) => [name, shownSetting(held, scope)])) : HIDDEN_VALUE]),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
