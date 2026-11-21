// Prints the simulation's scorecard (scorecard.mjs) for a folder of Shots,
// the committed corpus where none is named.
//
// Usage: npm run simulation-scorecard -- [<folder>] [--json] [--shots] [--set <label>]...
//   <folder>  Shots as pull.mjs saves them, or corpus Shots; corpus/shots by default.
//   --json    the scorecard as JSON instead of a table, with each Shot and each set pair under --shots.
//   --shots   each Shot's own line too: its kind, model and errors, or why it has no fit.
//   --set     a set's table too: each Shot's puck against each other Shot of it, as a designed session's;
//             printed with the table output only, not with --json.

import path from "node:path";
import { formatScorecard, formatSetPairs, readShots, scorecard } from "./scorecard.mjs";

const args = process.argv.slice(2);
const sets = args.flatMap((arg, n) => (args[n - 1] === "--set" ? [arg] : []));
if (args.some((arg, n) => (arg === "--set" && (args[n + 1] === undefined || args[n + 1].startsWith("--"))) || arg.startsWith("--set="))) {
  console.error("--set takes a set's label as the next argument: --set s14");
  process.exit(2);
}
const folder = args.find((arg, n) => !arg.startsWith("--") && args[n - 1] !== "--set") ?? path.join(import.meta.dirname, "corpus", "shots");
const card = scorecard(readShots(folder));
if (args.includes("--json")) {
  console.log(JSON.stringify(args.includes("--shots") ? card : { ...card, shots: undefined, sets: { ...card.sets, pairs: undefined } }, null, 2));
} else {
  if (args.includes("--shots")) {
    for (const shot of card.shots) {
      const apart = shot.noCoffee ? "met no coffee, counted apart; " : "";
      const errors = apart + (shot.errors ? `duration ${(shot.errors.durationShare * 100).toFixed(1)}%, peak ${shot.errors.peakPressure.toFixed(2)} bar${shot.within ? ", within" : ""}` : `no fit: ${shot.noFit}`);
      console.log(`${shot.name}  ${shot.model ?? "no model"}  ${shot.tea ? "tea" : (shot.kind ?? "-")}${shot.set ? `  set ${shot.set}` : ""}  ${errors}`);
    }
    console.log("");
  }
  console.log(formatScorecard(card));
  for (const set of sets) {
    const ofSet = card.shots.filter((shot) => shot.set === set).length;
    console.log(`\n${formatSetPairs(card, set) ?? (ofSet === 0 ? `No Shot is in set ${set}.` : `Set ${set} has no pairs: fewer than two of its ${ofSet} Shots take part, as tea Shots, those that met no coffee and those with no fit don't.`)}`);
  }
}
