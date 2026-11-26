import "reflect-metadata";
import type { ToolOptions } from "@nestjs/mcp";
import { DraftsTools } from "./drafts.tools.js";
import { LibraryChangesTools } from "./library-changes.tools.js";
import { LibraryTools } from "./library.tools.js";
import { LocationChangesTools } from "./location-changes.tools.js";
import { LocationsTools } from "./locations.tools.js";
import { MachineChangesTools } from "./machine-changes.tools.js";
import { MachinesTools } from "./machines.tools.js";
import { RecipeChangesTools } from "./recipe-changes.tools.js";
import { RecordChangesTools } from "./record-changes.tools.js";
import { RecordsTools } from "./records.tools.js";
import { SimulationTools } from "./simulation.tools.js";
import { SoftwareTools } from "./software.tools.js";

/**
 * The classes whose methods are the MCP endpoint's tools, grouped by area:
 * the providers `McpEndpointModule` registers, and so every tool the server
 * offers. A new class of tools is added here.
 */
export const TOOL_PROVIDERS = [
  LocationsTools,
  LocationChangesTools,
  LibraryTools,
  LibraryChangesTools,
  RecipeChangesTools,
  MachinesTools,
  MachineChangesTools,
  SoftwareTools,
  RecordsTools,
  RecordChangesTools,
  SimulationTools,
  DraftsTools,
] as const;

/** Where `@nestjs/mcp` records a method's `@Tool` on it (its `MCP_PRIMITIVE_METADATA`, which it doesn't export). */
const PRIMITIVE = "nestjs:mcp:primitive";

/** A tool as the documentation site's reference lists it (site/src/assistant-tools.mjs). */
export interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  /** Whether it only reads: a tool that doesn't needs the Connected App to be allowed to change. */
  readOnly: boolean;
}

/**
 * Every tool the MCP endpoint offers, as its own declaration (`BudgetedTool`)
 * gives it, in the order declared: read off the classes, with no server
 * started. The documentation site builds its Assistant tools page from
 * these, through the compiled server.
 */
export function toolDefinitions(): ToolDefinition[] {
  return TOOL_PROVIDERS.flatMap((provider) => {
    const prototype: object = provider.prototype;
    return Object.getOwnPropertyNames(prototype).flatMap((key) => {
      const method: unknown = Object.getOwnPropertyDescriptor(prototype, key)?.value;
      if (typeof method !== "function") return [];
      const primitive = Reflect.getOwnMetadata(PRIMITIVE, method) as { kind: string; options: ToolOptions } | undefined;
      if (primitive?.kind !== "tool") return [];
      const { name, title, description, annotations } = primitive.options;
      return [{ name: name ?? key, title: title ?? "", description: description ?? "", readOnly: annotations?.readOnlyHint === true }];
    });
  });
}
