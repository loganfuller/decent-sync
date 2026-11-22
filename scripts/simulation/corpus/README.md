# The simulation's corpus

Real Shots the simulation's scorecard runs on (#599), scrubbed to what the
simulation reads, so that a test holds how close it comes to them.
`scripts/test/simulation-scorecard.test.ts` fails when the share of a model's
coffee Shots within the margin falls below the level in `levels.json`, and
when a file here holds anything outside the scrubbed shape.

## What is here

`shots/` holds 171 Shots, committed from 2026-11-20 to 2026-11-22 with their
owners' consent:

- 92 from two DE1XXL at a cafe and 28 from a DE1Pro in a lab, the project
  owner's, up to a few of each kind of Profile they had pulled, three of them
  tea;
- 30 from a Bengle whose owner agreed to share them, from its Shots recorded
  since late August 2026, whose records name their model; two of them ran
  under its manual modes, and have no fit;
- 10 from the lab's DE1Pro in a designed session (#600), `de1pro-029` to
  `de1pro-038`, set `s14`: one washed coffee, one grind, 18 g in one Basket,
  two Shots each of five contrasting Profiles, a flat 9 bar, a flat 6 bar, a
  fast fill with a pump-off soak, a low-pressure soak with a lever's decline
  and a 30 s bloom, each run to its target weight. The second bloom Shot's
  coffee, and 1 g of the first's, was the same coffee roasted a week
  earlier; the second flat 9 bar Shot sprayed, as a channel does;
- 11 from the lab's DE1Pro in a second designed session (#624),
  `de1pro-039` to `de1pro-049`: one coffee, 18 g in one Basket, a
  Slayer-style Profile (a 1.5 ml/s pre-brew until 4 bar or 40 s, then a flat
  9 bar) at three grinds, with a 1.0 and a 2.0 ml/s pre-brew and a flat
  9 bar control after a fast fill, each run to its target weight: 039 to
  044 at the middle grind (four Slayer-style Shots, the first pulled hours
  before the rest, then the control twice), 045 and 046 a step finer, 047
  and 048 a step coarser, and 049 at the middle grind again. They are
  the corpus's only Shots of a long low-flow pre-brew that builds pressure
  before the first drip. They join no set: the grinder warmed through the
  session and its pucks loosened with it, so no two of them can be taken
  for one puck. The control's second Shot ran 19% shorter than its first,
  the finer grind's Shots shorter than 039 and 040 at the middle grind,
  and 049 11 s shorter than 040 at the same setting; 047 and 049 ran their
  whole pre-brew without reaching 4 bar and never built 9 bar.

They were chosen by Machine and kind of Profile, spread over time, and by
set, without looking at how well the simulation fits them. Sets were
inferred from the cafe's and the Bengle's Shots (`scrub.mjs --sets`). The
lab DE1Pro's other Shots join none, as the coffee recorded on it is not kept
up to date; the first designed session's were marked as one (`scrub.mjs --set`).

`levels.json` holds each model's share within the margin when the corpus was
last scored, as Shots within it out of the Shots counted: 126 of 134 DE1 coffee
Shots and 17 of 23 Bengle Shots, with the puck of #602 (115 of 123 before the
Slayer-style session; 92 and 17 with the
machine fitted to the corpus, #601, and v1.12.0's puck; 55 of 113 and 12 of 23
with v1.12.0's machine, before the designed session's ten). It also holds, for
#602, the median duration error of one Shot's puck run with another Profile's
steps in its set (`differentSteps`, a ceiling), and how many pump-off soaks
that end as pressure falls last within a second of their Shots' (`soaks`). Nine corpus Shots are pours that met no coffee (four DE1, five
Bengle), kept as recorded and counted toward no share.

## A corpus Shot

Each file is one Shot, named for its Machine's model and numbered:

- `model`: the Machine model Decaid recorded, as `DE1XXL` or `Bengle`;
- `dose` and `yield`, g, the dose as weighed or else as set; `stopReason`,
  as Decaid recorded it;
- `tea`: true for a tea Shot, which counts toward no share; `set`, as `s3`,
  for Shots of one coffee, grind and dose;
- `profile`: the Shot's own profile as Decaid reads it, with no title,
  author or notes, its steps numbered from `"1"` instead of named;
- `samples`: its samples after Preheat, as columns of equal length: `seconds`
  from the start of its profile, `frame`, the step running, `pressure` and
  `flow` to three places, `targetPressure` and `targetFlow`, the targets its
  Machine reported, null where none, and `weight` to two places, null where
  the scale read none.

Nothing else: no id, serial number, firmware version, real time or note, and
no name of a person, Location, Machine, Bean, Grinder, Basket or Profile.

## Adding Shots

1. Pull them read-only into a folder outside the repo (`pull.mjs`,
   [DEVELOPMENT.md](../../../docs/DEVELOPMENT.md#the-simulations-scorecard)),
   only from an instance whose owner agrees to their Shots being published.
2. Scrub the ones to add: `node scripts/simulation/scrub.mjs <folder> --ids <file of ids>`,
   with `--set` for Shots of one coffee, grind and dose, as a designed
   session's, or `--sets` to infer sets, and `--no-sets-for <Machine name>` for
   a Machine whose recorded coffee can't be trusted. It numbers files and sets
   on from those here, and leaves out a Shot whose record names no model.
3. Read every file it wrote: the repo is public.
4. Run `npm run simulation-scorecard` and the test, and set `levels.json` to
   the new shares.
