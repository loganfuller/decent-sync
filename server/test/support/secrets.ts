// Tokens and link secrets must never reach a log (AGENTS.md). Each test server
// records every secret it hands out, to any client (secret-capture.mjs, which
// startTestServer preloads), and tests remember the tokens they hand a tablet
// or send in a hello, issued or not. Once a test file has run, every server's
// and simulated tablet's log it started is checked for all of them
// (server/test/support/setup.ts; e2e/support/fresh-server.ts for Playwright).

/** Shorter strings, such as a test's token "x", are no real secret and would match ordinary log text. */
const MIN_LENGTH = 20;

const remembered = new Set<string>();
const sources: (() => readonly string[])[] = [];
const logs: { whose: string; read: () => string }[] = [];

/** Remembers a token a test hands a tablet or sends in a hello, so no log may hold it. */
export function rememberSecret(secret: unknown): void {
  if (typeof secret === "string") remembered.add(secret);
}

/** Has the secrets something hands out, such as a test server, checked for too. */
export function watchSecrets(read: () => readonly string[]): void {
  sources.push(read);
}

/** Has a log checked for the secrets, once the test file has run. */
export function watchLog(whose: string, read: () => string): void {
  logs.push({ whose, read });
}

/** Throws if a log watched holds a secret, naming the log but not the secret. */
export function assertNoSecretLogged(): void {
  const secrets = [...remembered, ...sources.flatMap((read) => read())].filter((secret) => secret.length >= MIN_LENGTH);
  const leaked = logs.filter(({ read }) => {
    const log = read();
    return secrets.some((secret) => log.includes(secret));
  });
  if (leaked.length > 0) throw new Error(`A token or link secret reached ${leaked.map(({ whose }) => whose).join(", ")}`);
}
