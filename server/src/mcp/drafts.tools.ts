import { BadRequestException, Injectable } from "@nestjs/common";
import type { McpContext } from "@nestjs/mcp";
import { MACHINE_MODELS, STARTING_SHAPES } from "@decent-sync/protocol";
import * as z from "zod";
import { CHANGE, READ } from "../connected-apps/oauth.js";
import { type DraftSummary, type DraftView, DraftsService, MAX_DRAFT_STEPS } from "../library/drafts.service.js";
import { readProfileId } from "../library/profiles.service.js";
import { type Budget, BudgetedTool } from "./budget.js";
import { askedCurves } from "./curves.js";
import { editorOf } from "./library-changes.tools.js";
import { profileShape, source } from "./library.tools.js";
import { RUN_CURVES, simulateBudget, simulateInput, simulateOutput, simulationOf } from "./simulation.tools.js";
import { callerOf } from "./token-verifier.js";

// Drafts through an assistant (ADR-0026, ADR-0032, ticket #579), as the
// REST API has them (`DraftsService`): listed, read, started from a Library
// Profile, a starting shape or a profile, saved, simulated and discarded,
// by an Admin or Staff, as anyone who may change the Library may. A Viewer
// sees none. Publishing one is ticket #580.

const id = z.string();
const CHANGES = { readOnlyHint: false, destructiveHint: false, openWorldHint: false } as const;

/** What a Draft is, for the tools' descriptions. */
const DRAFTS =
  "A Draft is a profile being written or changed here, held by Decent Sync alone and on no tablet until it is published, which these tools don't do: the person publishes it from its page in the management interface. Admins and Staff may read, change and discard any Draft, the later save winning; a Viewer sees none. Its times are UTC.";

const checkShape = z.object({ code: z.string(), step: z.number().nullable(), path: z.string().optional(), message: z.string() });

const draftSummary = z.object({
  id,
  title: z.string().describe("Its profile's title; empty for none yet."),
  startedFrom: z
    .object({ id, title: z.string().nullable(), bundled: z.boolean().nullable() })
    .nullable()
    .describe("The Library Profile it was started from, to change it (publishesAs version) or as a copy (separate); title and bundled null where the Library no longer has it. Null for one started from a starting shape or a profile."),
  shape: z.object({ key: z.string(), title: z.string() }).nullable().describe("The starting shape it was started from; null for one started otherwise."),
  publishesAs: z.enum(["version", "separate"]).describe("What publishing it makes: a new Profile Version of startedFrom (version), or a Profile of its own (separate)."),
  savedBy: source.describe("Who saved it last."),
  savedAt: z.string().describe("When it was saved last."),
  saves: z.number().describe("How many times it has been saved, its start the first: edit_draft names the count its change started from."),
  createdAt: z.string(),
});

const draftItem = draftSummary.extend({
  profile: profileShape,
  profileId: z.string().describe("The id Decaid would give its profile, which publishing it would make a Profile under."),
  models: z.array(z.enum(MACHINE_MODELS)).describe("The models the account has Machines of: its values are held to the widest of their ranges."),
  machineModel: z.enum(MACHINE_MODELS).describe("The model simulate_draft simulates it as where none is asked for."),
  checks: z
    .object({ blocking: z.array(checkShape), advice: z.array(checkShape) })
    .describe(
      "Its checks, but those of a simulated run, which simulate_draft adds: blocking, what would stop it being published, as no title, no steps, a step with no name, a value out of range, more steps than a machine takes or steps a Library Profile has (sameSteps); and advice, what the machine accepts but may not be meant, each naming its step by index, or null for the whole profile.",
    ),
});

/** A Draft's profile, its steps, title, author and notes among it, given as it is (ADR-0028): rounded or cut, it would be another profile, which edit_draft, given it back, would refuse. */
const DRAFT_WHOLE = ["/draft/profile/title", "/draft/profile/author", "/draft/profile/notes", "/draft/profile/version", "/draft/profile/beverage_type", "/draft/profile/steps", "/draft/profile/tank_temperature", "/draft/profile/target_weight", "/draft/profile/target_volume", "/draft/profile/target_volume_count_start"];
const draftBudget: Budget = { whole: DRAFT_WHOLE };

const listOutput = z.object({ drafts: z.array(draftSummary).describe("Every Draft, the one saved last first.") });
const draftOutput = z.object({ draft: draftItem });
const heldShape = z.object({ step: z.number().nullable(), path: z.string(), from: z.number(), to: z.number() });

const shapeKeys = STARTING_SHAPES.map((shape) => shape.key) as [string, ...string[]];

const createInput = z.object({
  profileId: id.optional().describe("A Library Profile to start it from, with as."),
  as: z
    .enum(["version", "separate"])
    .optional()
    .describe("With profileId: version, to change that Profile, publishing as a new version of it, which one of Decaid's bundled Profiles refuses; or separate, a copy titled with \" copy\" after its title."),
  shape: z
    .enum(shapeKeys)
    .optional()
    .describe(`A starting shape to start it from, as a separate Profile: ${STARTING_SHAPES.map((shape) => `${shape.key} (${shape.title}: ${shape.description})`).join("; ")}`),
  profile: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("A profile to start it from, as a separate Profile: Decaid's profile JSON, a bare profile or a whole record holding it under profile, as an imported file is. Its values are held to the ranges, and held lists what was."),
});

const editInput = z.object({
  id: id.describe("The Draft."),
  saves: z.number().int().min(1).describe("The count of saves the change started from: the Draft's saves as last read. A save is taken whatever it names, and between says whether someone saved it meanwhile."),
  profile: profileShape.optional().describe(`Its whole profile as it should be, every field and step, up to ${MAX_DRAFT_STEPS} steps; left as it is where not given. Each value must be in the ranges of a model the account has Machines of.`),
  publishesAs: z.enum(["version", "separate"]).optional().describe("What publishing it makes; version only for a Draft started from a Library Profile."),
});

const editOutput = draftOutput.extend({
  between: z
    .object({ saves: z.number(), savedBy: source, savedAt: z.string() })
    .nullable()
    .describe("Saves made between the count given and this one: how many, and the latest of them, whose change this save replaced; null where none did."),
});

const simulateDraftInput = simulateInput.omit({ profileId: true }).extend({ id: id.describe("The Draft to simulate.") });
const simulateDraftOutput = simulateOutput.omit({ profile: true }).extend({ draft: z.object({ id, title: z.string() }) });

@Injectable()
export class DraftsTools {
  constructor(private readonly drafts: DraftsService) {}

  @BudgetedTool({
    name: "list_drafts",
    title: "List Drafts",
    description: `Lists every Draft, the one saved last first, each with what it will publish as and who saved it last. ${DRAFTS}`,
    outputSchema: listOutput,
    annotations: { readOnlyHint: true },
    scopes: [READ],
  })
  async listDrafts(_: unknown, context: McpContext): Promise<{ drafts: DraftSummary[] }> {
    return { drafts: await this.drafts.list(callerOf(context).scope) };
  }

  @BudgetedTool({
    name: "get_draft",
    title: "Read a Draft",
    description: `Reads a Draft: its whole profile, as Decaid reads one, what it will publish as, who saved it last, how many times it has been saved, and its checks. ${DRAFTS}`,
    inputSchema: z.object({ id: id.describe("The Draft.") }),
    outputSchema: draftOutput,
    annotations: { readOnlyHint: true },
    scopes: [READ],
    budget: draftBudget,
  })
  async getDraft({ id: draftId }: { id: string }, context: McpContext): Promise<{ draft: DraftView }> {
    return { draft: await this.drafts.get(draftId, callerOf(context).scope) };
  }

  @BudgetedTool({
    name: "create_draft",
    title: "Start a Draft",
    description: `Starts a Draft, from one of: a Library Profile (profileId, with as), a starting shape (shape) or a profile (profile), such as one written from a person's description; then edit_draft changes it and simulate_draft simulates it. Returns it as get_draft does, with held: the values of a profile given that were held to the ranges, each from what to what. ${DRAFTS}`,
    inputSchema: createInput,
    outputSchema: draftOutput.extend({ held: z.array(heldShape) }),
    annotations: CHANGES,
    scopes: [READ, CHANGE],
    budget: draftBudget,
  })
  async createDraft(input: z.infer<typeof createInput>, context: McpContext): Promise<{ draft: DraftView; held: unknown[] }> {
    const given = [input.profileId, input.shape, input.profile].filter((value) => value !== undefined).length;
    if (given !== 1) throw new BadRequestException("Start a Draft from one of profileId, with as, shape or profile");
    const start =
      input.profileId !== undefined
        ? { kind: "profile" as const, profileId: readProfileId(input.profileId), publishesAs: input.as ?? missingAs() }
        : input.shape !== undefined
          ? { kind: "shape" as const, shape: input.shape }
          : { kind: "file" as const, content: input.profile };
    return this.drafts.create(start, editorOf(context), callerOf(context).scope);
  }

  @BudgetedTool({
    name: "edit_draft",
    title: "Change a Draft",
    description: `Saves a change to a Draft: its whole profile, as get_draft gave it with the change made, and what it will publish as. Returns it as get_draft does. ${DRAFTS}`,
    inputSchema: editInput,
    outputSchema: editOutput,
    annotations: CHANGES,
    scopes: [READ, CHANGE],
    budget: draftBudget,
  })
  async editDraft({ id: draftId, saves, profile, publishesAs }: z.infer<typeof editInput>, context: McpContext): Promise<z.infer<typeof editOutput>> {
    if (profile === undefined && publishesAs === undefined) throw new BadRequestException("Give profile, publishesAs or both to change");
    return (await this.drafts.save(draftId, { profile, publishesAs, saves }, editorOf(context), callerOf(context).scope)) as z.infer<typeof editOutput>;
  }

  @BudgetedTool({
    name: "simulate_draft",
    title: "Simulate a Draft",
    description: `Simulates a Draft as simulate_profile simulates a Library Profile, taking the same puck, dose, stop-at weight, model and curves, and answering the same, with the Draft named in place of the Profile: on the model of the Profile it was started from, where none is asked for, else a DE1, or a Bengle where every Machine of the account is one. Its checks are get_draft's with those of the run. ${DRAFTS}`,
    inputSchema: simulateDraftInput,
    outputSchema: simulateDraftOutput,
    annotations: { readOnlyHint: true },
    scopes: [READ],
    budget: simulateBudget,
  })
  async simulateDraft(input: z.input<typeof simulateDraftInput>, context: McpContext): Promise<z.infer<typeof simulateDraftOutput>> {
    const { curves = true, id: draftId, ...ask } = input;
    if (ask.shotId !== undefined && ask.grind !== undefined) throw new BadRequestException("Choose a Shot's puck or the standard puck's grind, not both");
    const { draft, ...simulation } = await this.drafts.simulate(
      draftId,
      { shotId: ask.shotId ?? null, grind: ask.grind ?? 0, dose: ask.dose ?? null, stopAt: ask.stopAt ?? null, model: ask.model ?? null },
      callerOf(context).scope,
    );
    const { profile: _, ...answer } = simulationOf({ profile: { id: draft.id, title: draft.title }, ...simulation }, askedCurves(RUN_CURVES, curves));
    return { draft, ...answer };
  }

  @BudgetedTool({
    name: "discard_draft",
    title: "Discard a Draft",
    description: `Discards a Draft, which leaves nothing of it behind: ask the person first. ${DRAFTS}`,
    inputSchema: z.object({ id: id.describe("The Draft.") }),
    outputSchema: z.object({ discarded: z.literal(true) }),
    annotations: { ...CHANGES, destructiveHint: true, idempotentHint: false },
    scopes: [READ, CHANGE],
  })
  async discardDraft({ id: draftId }: { id: string }, context: McpContext): Promise<{ discarded: true }> {
    await this.drafts.discard(draftId, callerOf(context).scope);
    return { discarded: true };
  }
}

function missingAs(): never {
  throw new BadRequestException('Give as with profileId: "version" to change the Profile, or "separate" for a copy of it');
}
