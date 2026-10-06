// Tokens and link secrets must never reach a log (AGENTS.md). Tests remember
// every one they are given or hand to a tablet, and once a test file has run,
// every server's and simulated tablet's log it started is checked for them
// (server/test/support/setup.ts; e2e/support/fresh-server.ts for Playwright).

/** Shorter strings, such as a test's token "x", are no real secret and would match ordinary log text. */
const MIN_LENGTH = 20;

const secrets = new Set<string>();
const logs: { whose: string; read: () => string }[] = [];

/** Remembers a token or link secret, so no log may hold it. */
export function rememberSecret(secret: unknown): void {
  if (typeof secret === "string" && secret.length >= MIN_LENGTH) secrets.add(secret);
}

/** Has a log checked for the secrets remembered, once the test file has run. */
export function watchLog(whose: string, read: () => string): void {
  logs.push({ whose, read });
}

/** Throws if a log watched holds a secret remembered, naming the log but not the secret. */
export function assertNoSecretLogged(): void {
  const leaked = logs.filter(({ read }) => {
    const log = read();
    return [...secrets].some((secret) => log.includes(secret));
  });
  if (leaked.length > 0) throw new Error(`A token or link secret reached ${leaked.map(({ whose }) => whose).join(", ")}`);
}
