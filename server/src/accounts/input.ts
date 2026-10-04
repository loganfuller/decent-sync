import { BadRequestException } from "@nestjs/common";
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from "./passwords.js";

// Request bodies for the account endpoints, checked by hand: there are few
// fields, and each problem gets a message the management interface can show.

/** The longest valid email address. */
const MAX_EMAIL_LENGTH = 254;

export interface Credentials {
  email: string;
  password: string;
}

export interface NewAccount extends Credentials {
  name: string;
}

export function readCredentials(body: unknown): Credentials {
  const fields = asObject(body);
  const email = normaliseEmail(fields.email);
  const password = fields.password;
  if (!email || typeof password !== "string" || password.length === 0) {
    throw new BadRequestException("Enter an email and password");
  }
  if (email.length > MAX_EMAIL_LENGTH) throw new BadRequestException("Enter a valid email address");
  return { email, password };
}

export function readNewAccount(body: unknown): NewAccount {
  const fields = asObject(body);
  const problems: string[] = [];

  const name = typeof fields.name === "string" ? fields.name.trim() : "";
  if (!name) problems.push("Enter a name");
  else if (name.length > 100) problems.push("Use a name of at most 100 characters");

  const email = normaliseEmail(fields.email);
  if (!email || !/^[^\s@]+@[^\s@]+$/.test(email) || email.length > MAX_EMAIL_LENGTH) {
    problems.push("Enter a valid email address");
  }

  const password = typeof fields.password === "string" ? fields.password : "";
  if (password.length < MIN_PASSWORD_LENGTH) {
    problems.push(`Use a password of at least ${MIN_PASSWORD_LENGTH} characters`);
  } else if (password.length > MAX_PASSWORD_LENGTH) {
    problems.push(`Use a password of at most ${MAX_PASSWORD_LENGTH} characters`);
  }

  if (problems.length > 0) throw new BadRequestException(problems);
  return { name, email: email!, password };
}

/** Emails are compared trimmed and lower-cased. */
function normaliseEmail(value: unknown): string | undefined {
  return typeof value === "string" ? value.trim().toLowerCase() || undefined : undefined;
}

function asObject(body: unknown): Record<string, unknown> {
  return typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
}
