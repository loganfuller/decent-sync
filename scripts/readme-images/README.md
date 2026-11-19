# README images

Regenerates the images in `docs/images/` that `README.md` shows, each in light and dark: the Live View GIF, and stills of the Overview, a Location's page, a Shot's page, a Profile's page, the Library's Bean Batches and a Machine's Live View on a phone.

## Running it

You need:

- the test PostgreSQL (`npm run db:test`), with `TEST_DATABASE_URL` naming it in the environment or `.env`;
- a current build (`npm run build`, or `npm run build:stale`);
- ffmpeg on `PATH` (macOS: `brew install ffmpeg`).

```bash
npm run readme-images                  # into dist/readme-images
npm run readme-images -- <directory>   # into a directory of your own
```

- A whole run takes about 4 minutes.
- The output directory holds the encoded images, named as in `docs/images/`; `raw/` holds the captures, and `playwright/` a failed run's trace.
- It empties an output directory an earlier run made, and refuses any other that is not empty.
- `node scripts/readme-images/encode.mjs <directory>/raw <directory>` encodes the captures again without capturing them.
- Look at every image and compare it with the one in `docs/images/`, then copy over only those the change redraws.
- Every run differs from the last in its dates, times and encoding noise, so an image whose page did not change stays as committed.

The spec reads these from the environment:

| Variable | Effect |
|---|---|
| `STILLS=overview,location` | Captures only the stills named, of `overview`, `location`, `bean-batches`, `shots`, `shot` and `profile`. Unset, every one. |
| `SKIP_STILLS=1` | Captures no stills: only the Live View GIF and the phone. |
| `SKIP_LIVE=1` | Captures only the stills. With `STILLS`, a run takes under 20 seconds. |
| `SCREENSHOT_ZONE`, `SCREENSHOT_ZONE_HOURS` | The time zone of the Locations, the browser and the tablets, and its hours ahead of UTC. Default `America/Toronto` and `-5`. |
| `SAMPLE_SHOTS=<file>` | Reads a fresh sample instead of `sample-shots.json`. |

- The `shots` still, the Shots list, is not in the README.

## What is here

- `run.mjs`: `npm run readme-images`. Runs the spec, then the encoder.
- `readme-images.spec.ts`: seeds a fresh test server through simulated tablets running the built plugin, and captures the pages.
- `playwright.config.ts`: the spec's own config. The spec is outside `e2e/`, so `npm run test:e2e` and CI never run it.
- `encode.mjs`: turns the captures into palette PNGs and GIFs with ffmpeg.
- `sample.mjs`: samples Shots from a running server into an anonymized file (A fresh sample, below).
- `sample-shots.json`: its output, nine Shots, which the spec reads.

## What the images show

- The Locations (Downtown, Riverside, Roastery Lab), Machines, serials, Library, roaster ("Lantern Coffee Roasters") and Baristas are made up.
- Every curve is a real recording: the Shots in `sample-shots.json`, and the repo's fixtures of a Shot with its Preheat and of the Live View (`de1pro-live-v0.9.0/shot.json`).
- The spec places each Shot at a time of its own and stretches its recording to a duration of its own (`k`, or `seconds`).

## Time and zone

- The latest Shot is a quarter of an hour before the run, since the Overview and the Recipe page show each Location's own today.
- Today's Shots go back about 4 hours, so run it where it is late morning or afternoon in the zone, or set the zone to one where it is.
- Choose a zone with no daylight saving.
- The Location's page shows the zone's name, and every still shows times in the zone.

## The stills

- A Shot's `updatedAt` must be UTC with a `Z`, or the server ignores it silently.
- Each tablet's own library is emptied, so no fixture's names reach the Library.
- Shots are pulled once the plugin has written the Library to the tablet, naming the tablet's local ids, so each Shot's page links its Bean Batch, Grinder and Basket.
- A Loaded Recipe needs the tablet to run a `SimulatedDye2`, and the Recipe applied through `openDye2Dashboard`.
- A Basket's name is unique in the Library: the spec creates one at Downtown and shows it at the other Locations.
- A Shot's Recipe is the one it names only where its Machine had it loaded as it was pulled, so the spec backdates each bar's Loaded Recipes in PostgreSQL. Without that every Shot falls under "No Recipe loaded" and no Reference Shot is offered.
- Each tablet reports an idle Machine State, or the Overview says "State not reported".
- `page.screenshot({ clip })` is cut at the viewport's edge, so the `location` capture uses a 1600 px tall viewport, the `shot` capture 2600 px, the `profile` capture 2000 px and the Live View 1400 px.
- The `overview` still runs to the bottom of Downtown's block.
- The `location` still runs to the bottom of the page's Recipes card.
- The captures wait, after every reload, for each Overview block's table and its two status cards.
- The `shot` still is Shot bl-1's "How it went" card and Curves card together: a clip from the top of one to the bottom of the other.
- The `profile` still is the page of Gentle and sweet, House Espresso's Profile: its "How it runs" card and Steps card together, as the page opens, on the standard puck.
- It compares bl-1 with its Recipe's Reference Shot, bl-4, whose "Reference Shot" radio is chosen already.
- bl-1 is rated 8 and bl-4 10 (Decaid's 0 to 10), so its Rating row reads in stars.

## Downtown's today

The Overview marks a duration more than 10% from the Reference Shot's, a yield more than 5% from its target, and fewer than 90% of Shots stopped at target, and judges a group only with at least 3 Shots.

- Downtown's today is shaped to give two marks and nothing else: House Espresso on Bar Right +3.0 s against its Reference Shot (bl-4, 26.1 s), and Guji Espresso 3.3 s apart between Machines.
- The spec's comment above `more` has the arithmetic.
- A placed Shot's `seconds` is its duration as the server counts it, from the first sample after the Preheat to the last.
- Keep each median off a .x5 boundary, or the rounded medians and the "s apart" figure disagree by 0.1: 27.65 shows as 27.6, and 29.1 - 27.65 as 1.4.
- `sample[7]` (39 s, +22% yield) is not placed at Downtown, and br-1, Bar Right's last Shot, is of the Guji it has loaded, so neither status card marks its last Shot.

## The Live View GIF

- It is captured from the Preheat on, one screenshot of the card after another, each with its time.
- It plays at twice the shot's speed, at 8 frames a second, 800 px wide.
- It is cropped to 482 px tall at that width, which drops the sliver of the Weight chart's legend the clip leaves. Recheck that height (`GIF_HEIGHT` in `encode.mjs`) when the card's layout changes.
- It ends on the last frame captured before the recording turns Idle, about 38.3 s into the capture, and holds it 6 s. After that the recording shows Idle, the scale at -189 g as the cup is lifted, and "Waiting for its Shot", which reads as a bug.
- The spec writes when the recording turns Idle into `capture.json` beside the frames, and `encode.mjs` cuts there.
- `getByRole("figure", { name })` matches a case-insensitive substring, so the Live View's `"Weight"` lookups take `exact: true`, or they would match the Weight flow chart too.
- The phone still is the Live View in a 390 x 844 viewport, mid-pour.

## A fresh sample

The committed sample is enough unless the curves need replacing.

```bash
SAMPLE_SERVER=<server URL> SAMPLE_EMAIL=<Admin email> SAMPLE_PASSWORD=<password> \
  node scripts/readme-images/sample.mjs <file>
```

- Sample only a server whose owner agrees to its Shots' curves being published.
- It signs in, makes only `GET` requests, and signs out.
- It keeps up to 24 espresso Shots of 18 to 60 s, at most 4 a profile, and only their physics: profile steps, curves, dose, yield and stop reason.
- It moves each Shot's samples by a whole number of milliseconds so the earliest falls in the first millisecond of 2000-01-01T00:00:00, keeping every interval between samples as recorded.
- Check every key and string in the file before committing it: the repo is public.
- A profile's title and step names come from whoever wrote it. A profile bundled with Decaid (`decaid:assets/defaultProfiles/`) names no one; give any other a made-up neutral title, in the file and wherever the spec names it.
- It prints the profiles in the order kept: recheck the spec's `sample[n]` indexes against them, and Downtown's arithmetic.
