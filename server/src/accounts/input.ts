import { BadRequestException, NotFoundException } from "@nestjs/common";
import { AccountRole } from "../generated/prisma/client.js";
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from "./passwords.js";

// Request bodies for the account endpoints, checked by hand: there are few
// fields, and each problem gets a message the management interface can show.

/** The longest valid email address. */
const MAX_EMAIL_LENGTH = 254;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  const name = readName(fields.name, problems);
  const email = readEmail(fields.email, problems);
  const password = readPassword(fields.password, problems);
  if (problems.length > 0) throw new BadRequestException(problems);
  return { name, email, password };
}

/** What an account may do: its role and, for Staff, the Locations they work at. */
export interface Access {
  role: AccountRole;
  /** The Locations a Staff member works at; none for an Admin, who may change anything anywhere. */
  locationIds: string[];
}

/** An invite: who it is for, and as what. */
export interface NewInvite extends Access {
  email: string;
}

export function readNewInvite(body: unknown): NewInvite {
  const fields = asObject(body);
  const problems: string[] = [];
  const email = readEmail(fields.email, problems);
  const access = readRole(fields, problems);
  if (problems.length > 0) throw new BadRequestException(problems);
  return { email, ...access };
}

/** An account's new role and, for Staff, the Locations they work at. */
export function readAccess(body: unknown): Access {
  const problems: string[] = [];
  const access = readRole(asObject(body), problems);
  if (problems.length > 0) throw new BadRequestException(problems);
  return access;
}

function readRole(fields: Record<string, unknown>, problems: string[]): Access {
  const role = fields.role === "admin" ? AccountRole.ADMIN : fields.role === "staff" ? AccountRole.STAFF : undefined;
  if (!role) problems.push("Choose Admin or Staff");
  let locationIds: string[] = [];
  if (role === AccountRole.STAFF) {
    const chosen = Array.isArray(fields.locationIds) ? fields.locationIds : [];
    if (chosen.length === 0) problems.push("Choose the Locations a Staff member works at");
    else if (!chosen.every((id) => typeof id === "string" && UUID.test(id))) problems.push(UNKNOWN_LOCATIONS);
    else locationIds = [...new Set(chosen.map((id) => (id as string).toLowerCase()))];
  }
  return { role: role!, locationIds };
}

/** Refuses Locations that are not all the server's. */
export const UNKNOWN_LOCATIONS = "Choose Locations from the list";

/** What an invited person enters: the email comes from the invite. */
export interface Acceptance {
  name: string;
  password: string;
}

export function readAcceptance(body: unknown): Acceptance {
  const fields = asObject(body);
  const problems: string[] = [];
  const name = readName(fields.name, problems);
  const password = readPassword(fields.password, problems);
  if (problems.length > 0) throw new BadRequestException(problems);
  return { name, password };
}

/** The new password a password reset link's holder chooses. */
export function readNewPassword(body: unknown): string {
  const problems: string[] = [];
  const password = readPassword(asObject(body).password, problems);
  if (problems.length > 0) throw new BadRequestException(problems);
  return password;
}

/** An account id from a path; anything that is not a UUID names no account. */
export function readAccountId(id: string): string {
  if (!UUID.test(id)) throw accountNotFound();
  return id;
}

export function accountNotFound(): NotFoundException {
  return new NotFoundException("No such account");
}

/** An invite id from a path. */
export function readInviteId(id: string): string {
  if (!UUID.test(id)) throw inviteNotFound();
  return id;
}

export function inviteNotFound(): NotFoundException {
  return new NotFoundException("No such invite");
}

function readName(value: unknown, problems: string[]): string {
  const name = typeof value === "string" ? value.trim() : "";
  if (!name) problems.push("Enter a name");
  else if (name.length > 100) problems.push("Use a name of at most 100 characters");
  return name;
}

function readEmail(value: unknown, problems: string[]): string {
  const email = normaliseEmail(value) ?? "";
  if (!/^[^\s@]+@[^\s@]+$/.test(email) || email.length > MAX_EMAIL_LENGTH) problems.push("Enter a valid email address");
  return email;
}

function readPassword(value: unknown, problems: string[]): string {
  const password = typeof value === "string" ? value : "";
  if (password.length < MIN_PASSWORD_LENGTH) {
    problems.push(`Use a password of at least ${MIN_PASSWORD_LENGTH} characters`);
  } else if (password.length > MAX_PASSWORD_LENGTH) {
    problems.push(`Use a password of at most ${MAX_PASSWORD_LENGTH} characters`);
  }
  return password;
}

/** Emails are compared trimmed and lower-cased. */
function normaliseEmail(value: unknown): string | undefined {
  return typeof value === "string" ? value.trim().toLowerCase() || undefined : undefined;
}

function asObject(body: unknown): Record<string, unknown> {
  return typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
}
