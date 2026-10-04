import { BadRequestException } from "@nestjs/common";

// Request bodies for the Machine endpoints, checked by hand like the other
// endpoints: each problem gets a message the management interface can show.

const MAX_NAME_LENGTH = 100;

export interface NewMachine {
  name: string;
}

export function readNewMachine(body: unknown): NewMachine {
  const fields = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  const name = typeof fields.name === "string" ? fields.name.trim() : "";
  if (!name) throw new BadRequestException(["Enter a name"]);
  if (name.length > MAX_NAME_LENGTH) throw new BadRequestException([`Use a name of at most ${MAX_NAME_LENGTH} characters`]);
  return { name };
}
