import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { assertBuilt } from "./support/builds.js";

// Runs the built server the way a self-hoster does, so `npm run build` first.
const main = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist/main.js");
assertBuilt("protocol", "server");

function start(env: Record<string, string>) {
  const { PATH, HOME } = process.env;
  return spawnSync(process.execPath, [main], {
    env: { PATH, HOME, ...env },
    encoding: "utf8",
    timeout: 20_000,
  });
}

describe("server startup", () => {
  it("refuses to start without its required environment variables, naming each one", () => {
    const result = start({});

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Decent Sync cannot start because of its environment variables");
    expect(result.stderr).toContain("DATABASE_URL is required");
    expect(result.stderr).toContain("PUBLIC_URL is required");
  });

  it("refuses a public URL that is not an http(s) origin", () => {
    const result = start({
      DATABASE_URL: "postgresql://localhost:5432/decent_sync",
      PUBLIC_URL: "ws://sync.example.com/sync",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("PUBLIC_URL must start with http:// or https://");
    expect(result.stderr).toContain("PUBLIC_URL must be an origin only");
  });

  it("refuses a CLIENT_ADDRESS_HEADER that is not an HTTP header name, naming the variable", () => {
    const result = start({
      DATABASE_URL: "postgresql://localhost:5432/decent_sync",
      PUBLIC_URL: "https://sync.example.com",
      CLIENT_ADDRESS_HEADER: "X Forwarded For",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("CLIENT_ADDRESS_HEADER must be an HTTP header name, such as X-Forwarded-For or X-Real-IP, not X Forwarded For");
  });
});
