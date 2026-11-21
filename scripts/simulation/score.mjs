// Prints the simulation's scorecard (scorecard.mjs) for a folder of Shots,
// the committed corpus where none is named.
//
// Usage: npm run simulation-scorecard -- [<folder>] [--json] [--shots]
//   <folder>  Shots as pull.mjs saves them, or corpus Shots; corpus/shots by default.
//   --json    the scorecard as JSON instead of a table.
//   --shots   each Shot's own line too: its kind, model and errors, or why it has no fit.

import path from "node:path";
import { formatScorecard, readShots, scorecard } from "./scorecard.mjs";

const args = process.argv.slice(2);
const folder = args.find((arg) => !arg.startsWith("--")) ?? path.join(import.meta.dirname, "corpus", "shots");
const card = scorecard(readShots(folder));
if (args.includes("--json")) {
  console.log(JSON.stringify(args.includes("--shots") ? card : { ...card, shots: undefined }, null, 2));
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
}
