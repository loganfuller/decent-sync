// Undo and redo through an editing session (#579): each change is a step
// back, but changes of one thing in quick succession, such as a handle
// dragged or a number typed, are one.

/** How close in time two changes of one thing are to be undone as one, ms. */
export const COALESCE_MS = 1_000;

/** The most changes kept to undo. */
export const MAX_UNDO = 200;

export interface EditHistory<T> {
  /** What was before each change, the earliest first. */
  past: T[];
  present: T;
  /** What each change undone was, the latest undone last. */
  future: T[];
  /** What the latest change changed, and when, ms, so the next change of it within COALESCE_MS joins it; null after an undo or redo. */
  last: { key: string; at: number } | null;
}

/** A history with nothing to undo. */
export function startHistory<T>(present: T): EditHistory<T> {
  return { past: [], present, future: [], last: null };
}

/**
 * The history after a change to `next`, naming what it changed as `key`: a
 * step back to undo, unless the latest change was of the same key within
 * COALESCE_MS of `now`, which it joins; a key of null joins nothing, as a
 * step added or moved. Anything undone can't be redone after it.
 */
export function recordChange<T>(history: EditHistory<T>, next: T, key: string | null, now: number): EditHistory<T> {
  if (Object.is(next, history.present)) return history;
  const joins = key !== null && history.last !== null && history.last.key === key && now - history.last.at < COALESCE_MS;
  const past = joins ? history.past : [...history.past, history.present].slice(-MAX_UNDO);
  return { past, present: next, future: [], last: key === null ? null : { key, at: now } };
}

export function canUndo<T>(history: EditHistory<T>): boolean {
  return history.past.length > 0;
}

export function canRedo<T>(history: EditHistory<T>): boolean {
  return history.future.length > 0;
}

/** The history with its latest change undone; as it is with none. */
export function undo<T>(history: EditHistory<T>): EditHistory<T> {
  const previous = history.past.at(-1);
  if (previous === undefined) return history;
  return { past: history.past.slice(0, -1), present: previous, future: [...history.future, history.present], last: null };
}

/** The history with its latest undone change made again; as it is with none. */
export function redo<T>(history: EditHistory<T>): EditHistory<T> {
  const next = history.future.at(-1);
  if (next === undefined) return history;
  return { past: [...history.past, history.present], present: next, future: history.future.slice(0, -1), last: null };
}
