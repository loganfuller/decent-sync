// Tokens and link secrets must never reach a log (AGENTS.md). Tests remember
// every token, link secret and session cookie the REST API hands AdminApi or
// a Playwright page, and every token they hand a tablet. Once a test file has
// run, every server's and simulated tablet's log it started is checked for
// them (server/test/support/setup.ts; e2e/support/fresh-server.ts).

/** Shorter strings, such as a test's token "x", are no real secret and would match ordinary log text. */
const MIN_LENGTH = 20;

const secrets = new Set<string>();
const logs: { whose: string; read: () => string }[] = [];

/** Remembers a token or link secret, so no log may hold it. */
export function rememberSecret(secret: unknown): void {
  if (typeof secret === "string" && secret.length >= MIN_LENGTH) secrets.add(secret);
}

/**
 * Remembers what a REST API response hands out: a token or link in its JSON
 * body, as a machine entry, an invite or a password reset link has, and the
 * session cookie it sets.
 */
export function rememberSecretsIn(body: unknown, setCookies: readonly string[] = []): void {
  const { token, link } = (body ?? {}) as { token?: unknown; link?: unknown };
  rememberSecret(token);
  if (typeof link === "string") rememberSecret(new URL(link).pathname.split("/").at(-1));
  for (const cookie of setCookies) rememberSecret(cookie.split(";")[0]!.split("=").slice(1).join("="));
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
