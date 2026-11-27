import type { BatchAtLocation, BatchMoveView, BatchRecipe, Location } from "@/lib/api";
import { grams } from "./remaining-weight";

// A Batch Move as the management interface words it (ADR-0037): what the
// move dialog says each Location will hold afterwards, what it sends, and
// the one line a move is in a batch's history; and what the confirmation
// before Finish here says finishing does, in the same lines. The server
// makes the move and works every weight out; what is here only says
// beforehand what it will do, from the weights as the page last read them.

/** How much of a batch a move takes: all of it, part of its weight, or, of a batch with no weight where it is, some of it. */
export type MoveHow = "all" | "part" | "some";

/** What a move asked for in the dialog would do, or why it can't be made. */
export interface MovePlan {
  /** What the request sends as its `amount`; undefined while the move can't be made. */
  amount?: number | "all" | "some";
  /** Why it can't be made as asked, to show in place of what it would do. */
  problem?: string;
  /** What each Location will hold afterwards, a line each. */
  lines: string[];
  /** What the button that makes it reads. */
  submit: string;
}

/** A Location's name with what it has of the batch, as the dialog's choice of where to move to reads. */
export function destinationText(location: Location, there: BatchAtLocation | undefined): string {
  if (there === undefined) return `${location.name}, which has none`;
  return there.remainingWeight === null ? `${location.name}, where it is not tracked` : `${location.name}, which has ${grams(there.remainingWeight)}`;
}

/** What the dialog says of the batch at the Location it leaves. */
export function sourceText(from: BatchAtLocation): string {
  return from.remainingWeight === null ? `It is at ${from.location.name}, with no weight entered there.` : `${from.location.name} has ${grams(from.remainingWeight)} of it.`;
}

/**
 * What moving the batch from one Location to another would do: `how` much,
 * with `entered` the grams typed for part of it. `there` is the batch at the
 * Location joined, undefined where it is not there. `recipes` is how many
 * Recipes at the Location left name the batch, and how many of those are in
 * a Recipe Slot, once read: a move of all finishes the batch there, and they
 * go on naming it.
 */
export function movePlan(
  from: BatchAtLocation,
  to: Location | undefined,
  there: BatchAtLocation | undefined,
  how: MoveHow,
  entered: string,
  recipes?: { naming: number; slotted: number },
): MovePlan {
  const left = from.location.name;
  const has = from.remainingWeight;
  const none: MovePlan = { lines: [], submit: "Move" };
  if (to === undefined) return none;
  const leaves = [`${left} stops listing the batch, and its tablets stop offering it.`, ...recipesLines(left, recipes)];

  if (has === null) {
    const unweighed = `No weight is entered for it at ${left}, so none moves.`;
    const reads = there === undefined ? ` It reads "Not tracked" at ${to.name} until a weight is entered there.` : "";
    if (how === "all") {
      return {
        amount: "all",
        lines: [there === undefined ? `The batch is added at ${to.name}.` : `The batch stays at ${to.name}, as it is.`, ...leaves, `${unweighed}${reads}`],
        submit: `Move all to ${to.name}`,
      };
    }
    if (there !== undefined) return { ...none, problem: `It is at ${to.name} already. Move all of it, or choose another Location.`, submit: `Move some to ${to.name}` };
    return {
      amount: "some",
      lines: [`The batch stays at ${left} and is added at ${to.name}.`, `${unweighed}${reads}`, `To move a known amount, enter its weight at ${left} first.`],
      submit: `Move some to ${to.name}`,
    };
  }

  const arrives = (amount: number) => {
    const now = there?.remainingWeight ?? null;
    if (now === null || now === 0) return `${to.name} will have ${grams(amount)}.`;
    // All of a Location that reads 0 g moves 0 g, which changes nothing where it arrives.
    return amount === 0 ? `${to.name} will have ${grams(now)}, as now.` : `${to.name} will have ${grams(now + amount)}: the ${grams(now)} there now and these ${grams(amount)}.`;
  };
  if (how === "all") return { amount: "all", lines: [arrives(has), ...leaves], submit: `Move all to ${to.name}` };
  const amount = entered.trim() === "" ? Number.NaN : Math.round(Number(entered) * 10) / 10;
  if (!(amount > 0) || amount >= has) {
    return { ...none, problem: entered.trim() === "" ? undefined : `Enter a weight above 0 and below ${grams(has)}. To move everything, choose All of it.`, submit: `Move to ${to.name}` };
  }
  return { amount, lines: [`${left} will have ${grams(has - amount)}.`, arrives(amount), "Tablets at both Locations show the new weights."], submit: `Move ${grams(amount)} to ${to.name}` };
}

/**
 * What finishing the batch at a Location does, as the confirmation before
 * Finish here says it, in the lines a move of all uses: the Location stops
 * listing it; the weight there goes with it, left out where it is untracked
 * there; and the Recipes there that name it go on naming it, left out where
 * none does or `recipes` was not read.
 */
export function finishLines(from: BatchAtLocation, recipes?: { naming: number; slotted: number }): string[] {
  const left = from.location.name;
  return [
    `${left} stops listing the batch, and its tablets stop offering it.`,
    ...(from.remainingWeight === null ? [] : [`The ${grams(from.remainingWeight)} there goes with it. No other Location's weight changes.`]),
    ...recipesLines(left, recipes),
  ];
}

/**
 * How many of the Recipes that name a batch are at a Location, and how many
 * of those are in a Recipe Slot, from the Recipes its page lists. Undefined
 * where the server listed none, as the release before does (ADR-0025).
 */
export function recipesAt(recipes: BatchRecipe[] | undefined, locationId: string): { naming: number; slotted: number } | undefined {
  if (recipes === undefined) return undefined;
  const naming = recipes.filter((recipe) => recipe.location?.id === locationId);
  return { naming: naming.length, slotted: naming.filter((recipe) => recipe.slot !== null).length };
}

/** What a move of all, or a finish, says of the Recipes at the Location left that name the batch: none where none does, or they were not read. */
function recipesLines(left: string, recipes: { naming: number; slotted: number } | undefined): string[] {
  if (recipes === undefined || recipes.naming === 0) return [];
  const { naming, slotted } = recipes;
  const name = naming === 1 ? `1 Recipe at ${left} names it and will go on naming it.` : `${naming} Recipes at ${left} name it and will go on naming it.`;
  const slots =
    slotted === 0
      ? ""
      : naming === 1
        ? ' It is in a Recipe Slot, and will read "Batch finished here".'
        : slotted === 1
          ? ' The one in a Recipe Slot will read "Batch finished here".'
          : ` The ${slotted} in Recipe Slots will read "Batch finished here".`;
  return [`${name}${slots}`];
}

/** A Batch Move in a batch's history: both Locations and the amount, such as "Moved 5700 g from Roastery Lab to Belmont". */
export function moveText(move: BatchMoveView): string {
  const from = move.from?.name ?? "a Location since deleted";
  const to = move.to?.name ?? "a Location since deleted";
  if (move.amount === null) return `Moved ${move.all ? "all" : "some"} from ${from} to ${to}, with no weight entered`;
  return move.all ? `Moved all, ${grams(move.amount)}, from ${from} to ${to}` : `Moved ${grams(move.amount)} from ${from} to ${to}`;
}
