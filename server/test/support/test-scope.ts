// Simulated tablets and raw connections keep working until they are ended:
// a tablet polls its Decaid and heartbeats, and the server's writer for each
// welcomed connection looks again at every Library change, on any Location.
// Left running until a file's afterAll, a file's earlier tests' tablets made
// its later tests several times slower. So Vitest's setup (setup.ts) ends
// each one a test opened once that test has run, unless the test is a step of
// a scenario (`runAsSteps`), whose later steps may use it; those end with the
// file, as before. Playwright specs, whose tests build on each other, keep
// theirs: only Vitest's setup listens.

/** Something a test opened that keeps working until it is ended. */
export interface Opened {
  end(): Promise<unknown>;
}

const listeners = new Set<(opened: Opened) => void>();

/** Tells each listener of something opened. */
export function opened(what: Opened): void {
  for (const listener of listeners) listener(what);
}

/** Calls the listener with everything opened from now until the returned function is called. */
export function listenForOpened(listener: (opened: Opened) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
