import { describe, expect, it } from "vitest";
import { SignInLimiter } from "../src/accounts/sign-in-limiter.js";

// A module test, because the REST API cannot fill the limiter in a test's
// time: every sign-in for a new email costs a password hash. The REST tests in
// accounts.test.ts cover the limit itself.

const MINUTE = 60_000;
const start = Date.UTC(2026, 9, 3, 12);

function lockOut(limiter: SignInLimiter, email: string, now: number): void {
  for (let i = 0; i < 5; i++) expect(limiter.begin(email, now)).toBeUndefined();
  expect(limiter.begin(email, now)).toBe(15 * 60);
}

describe("sign-in limiter", () => {
  it("keeps a lockout when sign-ins for other emails fill it", () => {
    const limiter = new SignInLimiter(10);
    lockOut(limiter, "admin@example.com", start);

    for (let i = 0; i < 100; i++) limiter.begin(`flood${i}@example.com`, start + MINUTE);

    expect(limiter.begin("admin@example.com", start + 2 * MINUTE)).toBe(13 * 60);
  });

  it("refuses emails it is not tracking while every slot holds a live window, until the oldest ends", () => {
    const limiter = new SignInLimiter(3);
    limiter.begin("a@example.com", start);
    limiter.begin("b@example.com", start + MINUTE);
    limiter.begin("c@example.com", start + 2 * MINUTE);

    expect(limiter.begin("d@example.com", start + 5 * MINUTE)).toBe(10 * 60);
    // Tracked emails carry on as before.
    expect(limiter.begin("b@example.com", start + 5 * MINUTE)).toBeUndefined();

    expect(limiter.begin("d@example.com", start + 15 * MINUTE)).toBeUndefined();
    expect(limiter.begin("e@example.com", start + 15 * MINUTE)).toBe(60);
  });

  it("lifts a lockout when its window ends, and forgets an email that signs in", () => {
    const limiter = new SignInLimiter();
    lockOut(limiter, "admin@example.com", start);
    expect(limiter.begin("admin@example.com", start + 15 * MINUTE)).toBeUndefined();

    for (let i = 0; i < 3; i++) limiter.begin("staff@example.com", start);
    limiter.succeeded("staff@example.com");
    lockOut(limiter, "staff@example.com", start);
  });
});
