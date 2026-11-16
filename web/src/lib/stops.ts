import type { StopKind } from "@/lib/api";

// The words for how a Shot stopped (#543), of the kind the server gives of
// the stop reason Decaid recorded (`ShotSpec.stopped`): the first two are
// stopped at target (GLOSSARY.md).

/** Each kind in words, as they follow "Stopped", but for the Machine's own ending, which stands alone. */
const STOP_WORDS: Record<Exclude<StopKind, "other">, string> = {
  targetWeight: "at its target weight",
  targetVolume: "at its target volume",
  byHand: "by hand",
  machineEnded: "ended by the Machine",
  error: "by an error",
};

/**
 * How a Shot stopped, in words: at its target weight, at its target volume,
 * by hand, ended by the Machine, by an error, or, for any other reason, and
 * where the server gave no kind, as the previous release during a deploy
 * (ADR-0025), the reason as recorded. None where it recorded no reason.
 */
export function stopWords(kind: StopKind | null | undefined, reason: string | null): string | undefined {
  if (kind === null || kind === undefined || kind === "other") return reason ?? undefined;
  return STOP_WORDS[kind];
}

/** The same as a sentence's start, as a field's value reads: "At its target weight", "Ended by the Machine", with a recorded reason as it is. */
export function stoppedText(kind: StopKind | null | undefined, reason: string | null): string | undefined {
  const words = stopWords(kind, reason);
  if (words === undefined || kind === null || kind === undefined || kind === "other") return words;
  return words.charAt(0).toUpperCase() + words.slice(1);
}
