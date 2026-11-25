# Images

One generator makes the images of the management interface that `README.md` and the documentation site show, each in light and dark: the Live View GIF, and stills of the Overview, a Location's page, a Shot's page, a Profile's page, the Shots list, the Library's Bean Batches, a Recipe's page, the New Profile page, a Draft's page, the Machines list, a Machine's Activity, Settings and Software tabs, and a Machine's Live View on a phone. `stills.ts` names each one.

## Committed and built

- The README's images are committed, in `docs/images/`: those `stills.ts` marks `readme`. A change that redraws one of their pages regenerates it in the same change, with `npm run readme-images`.
- The site's images are built: the site's deploy (`.github/workflows/release.yml`) generates every image into `site/generated/` with `npm run site-images` and builds the site with them. None is committed, and `site/generated/` is ignored by git.
- A build of the site without them, such as a pull request's or `npm run dev -w site`, shows the README's committed copy in their place, and an image the README does not commit as a line saying it is built at deploy (`site/src/pick-still.mjs`).
- A failed capture fails the site's deploy, and the release it follows stays published.
- A pull request that changes `web/` or this folder captures the page stills in CI's `stills` job (`LIVE_CHECK=1`, `--raw`), each asserting its page's content, and the run keeps the captures as its `stills` artifact, for a reviewer to look at. The Live View GIF and the phone are checked there rather than captured (`LIVE_CHECK`, below). Only their real-time recording and encoding are left to the deploy, so a change that breaks those fails the deploy rather than the pull request.

## Running it

You need:

- the test PostgreSQL (`npm run db:test`), with `TEST_DATABASE_URL` naming it in the environment or `.env`;
- a current build (`npm run build`, or `npm run build:stale`);
- ffmpeg on `PATH` (macOS: `brew install ffmpeg`), but for `--raw`.

```bash
npm run readme-images                  # into dist/readme-images, to copy over into docs/images/
npm run readme-images -- <directory>   # into a directory of your own
npm run site-images                    # into site/generated/, for the site's build to read
node scripts/images/run.mjs --raw <directory>   # captures only, into <directory>/raw: no encoding, no ffmpeg
```

- A whole run takes about 4 minutes, at any hour (Time and zone, below).
- The output directory holds the encoded images, named as in `docs/images/`; `raw/` holds the captures, and `playwright/` a failed run's trace.
- It empties an output directory an earlier run made, and refuses any other that is not empty.
- `node scripts/images/encode.mjs <directory>/raw <directory>` encodes the captures again without capturing them.
- For the README, look at every image it shows and compare it with the one in `docs/images/`, then copy over only those the change redraws.
- Every run differs from the last in its dates, times, time zone and encoding noise, so an image whose page did not change stays as committed.

The spec reads these from the environment:

| Variable | Effect |
|---|---|
| `STILLS=overview,location` | Captures only the page stills named, of `overview`, `location`, `bean-batches`, `shots`, `shot`, `profile`, `recipe`, `machines`, `machine-activity`, `machine-settings`, `machine-software`, `recipe-details`, `new-profile` and `draft`. Unset, every one. |
| `SKIP_STILLS=1` | Captures no page stills: only the Live View GIF and the phone. |
| `SKIP_LIVE=1` | Captures only the page stills. With `STILLS`, a run takes under 20 seconds. |
| `LIVE_CHECK=1` | Checks the Live View GIF and the phone instead of capturing them: in the light theme only, the shot replayed at 20 times its speed, the same assertions, the GIF's clip measured against `GIF_HEIGHT`, and one screenshot of each (`live-view-check-light.png`, `phone-light.png`). It adds about 15 seconds to a run of the page stills, needs no ffmpeg, and misses only what real-time recording and encoding would show, such as too few frames before the shot turns Idle. |
| `SCREENSHOT_ZONE` | The time zone of the Locations, the browser and the tablets, in place of the one the spec chooses. Choose one where it is the afternoon, with no daylight saving. |
| `SAMPLE_SHOTS=<file>` | Reads a fresh sample instead of `sample-shots.json`. |

## A still for a Guide page

A Guide page shows only an image the generator makes, by its name. To add one:

1. Name it in `STILLS` in `stills.ts`, with `readme: false` and what it shows.
2. Capture it in `images.spec.ts`: an entry of that name in `captures`, with the page's address, the `ready` check of what the page must show, and the `clip` to capture. The spec seeds the data it needs, so add to the seed if the page needs more. `ready` runs after every reload, before each theme's capture, so a page that stops showing what it should fails the capture rather than drawing a wrong image.
3. Rename the page from `.md` to `.mdx`, and show the image where it belongs:

   ```mdx
   import Still from "../../../components/Still.astro";

   <Still name="shots" alt="The Shots list, newest first, each Shot with its Recipe, Machine and how it ran" />
   ```

4. Run `STILLS=<name> SKIP_LIVE=1 npm run site-images`, then `npm run dev -w site`, and look at the page in both themes.

- The site's build fails on a name `stills.ts` lacks, and the deploy's on an image the generator did not make.
- Each image is shown twice, once a theme, and the site's theme picks which (`site/src/components/Still.astro`).

## What is here

- `run.mjs`: `npm run readme-images` and `npm run site-images`. Runs the spec, then the encoder.
- `stills.ts`: every image by name, and which the README commits.
- `images.spec.ts`: seeds a fresh test server through simulated tablets running the built plugin, and captures the pages.
- `zone.ts`: the time zone the capture runs in.
- `playwright.config.ts`: the spec's own config. The spec is outside `e2e/`, so `npm run test:e2e` never runs it.
- `encode.mjs`: turns the captures into palette PNGs and GIFs with ffmpeg.
- `sample.mjs`: samples Shots from a running server into an anonymized file (A fresh sample, below).
- `sample-shots.json`: its output, nine Shots, which the spec reads.

## What the images show

- The Locations (Downtown, Riverside, Roastery Lab), Machines, serials, Library, roaster ("Lantern Coffee Roasters") and Baristas are made up.
- Every curve is a real recording: the Shots in `sample-shots.json`, and the repo's fixtures of a Shot with its Preheat and of the Live View (`de1pro-live-v0.9.0/shot.json`).
- The spec places each Shot at a time of its own and stretches its recording to a duration of its own (`k`, or `seconds`).

## Time and zone

- The latest Shot is a quarter of an hour before the run, since the Overview and the Recipe page show each Location's own today.
- Today's Shots go back about 4 hours, and yesterday's from about 25 to 28 hours.
- So the spec runs in a zone where the latest Shot falls between 14:00 and 15:00: `zone.ts` has one for each whole hour from UTC-10 to UTC+13, none with daylight saving, and chooses by the hour of the run. Every run shows the same Shots on the same days.
- The Location's page shows the zone's name, and every still shows times in the zone, so both differ with the hour of the run.

## The stills

- A Shot's `updatedAt` must be UTC with a `Z`, or the server ignores it silently.
- Each tablet's own library is emptied, so no fixture's names reach the Library.
- Shots are pulled once the plugin has written the Library to the tablet, naming the tablet's local ids, so each Shot's page links its Bean Batch, Grinder and Basket.
- A Loaded Recipe needs the tablet to run a `SimulatedDye2`, and the Recipe applied through `openDye2Dashboard`.
- A Basket's name is unique in the Library: the spec creates one at Downtown and shows it at the other Locations.
- A Shot's Recipe is the one it names only where its Machine had it loaded as it was pulled, so the spec backdates each bar's Loaded Recipes in PostgreSQL. Without that every Shot falls under "No Recipe loaded" and no Reference Shot is offered.
- Each tablet reports an idle Machine State, or the Overview says "State not reported".
- `page.screenshot({ clip })` is cut at the viewport's edge, so the `location` capture uses a 1600 px tall viewport, the `shot` capture 2600 px, the `profile` capture 2000 px, `recipe-details` 3000 px, `new-profile` 1400 px, `draft` 2600 px and the Live View 1400 px.
- The `overview` still runs to the bottom of Downtown's block.
- The `location` still runs to the bottom of the page's Recipes card.
- The captures wait, after every reload, for each Overview block's table and its two status cards.
- The `shot` still is Shot bl-1's "How it went" card and Curves card together: a clip from the top of one to the bottom of the other.
- The `profile` still is the page of Gentle and sweet, House Espresso's Profile: its "How it runs" card and Steps card together, as the page opens, on the standard puck.
- It compares bl-1 with its Recipe's Reference Shot, bl-4, whose "Reference Shot" radio is chosen already.
- The `recipe-details` still is the Recipe card of House Espresso's page alone.
- The `new-profile` still is the New Profile page, down to its Import a file card.
- The `draft` still is a Draft of Gentle and sweet as a new version, its last pressure step a bar lower, down to the bottom of its graph: followed on the Lab's Machine, with one Trial Shot laid over the run.
- The Draft, the Lab being marked for trying Drafts, the following and the Trial Shot are made as the `draft` still's address is asked for, and it is the last still, so no other still shows them: the Shots list would gain a Shot, and the Lab's Machine lose what it has loaded.
- The Trial Shot is `lb-trial`, a Gentle and sweet recording pulled now with the profile the tablet's Workflow holds and no recipe, as a Shot must be to count as one (`docs/LIBRARY.md`, Following a Draft, and Trial Shots).
- bl-1 is rated 8 and bl-4 10 (Decaid's 0 to 10), so its Rating row reads in stars.
- The `recipe` still is House Espresso's page down to its By Machine card, where Bar Right's duration is marked.
- The `machines` still is the Machines list, to the bottom of its table.
- The `machine-activity`, `machine-settings` and `machine-software` stills are Bar Left's tabs, each opened by its address (`?tab=`).
- The `machine-activity` still stops under the dial-in trail's fourth entry: the one after it lists the whole Workflow in effect as the day began.
- The dial-in trail's "Recipe unloaded" entries at one time are the Loaded Recipes the spec backdates in PostgreSQL.
- The `machine-settings` still stops where the Tablet Settings start, so it shows the Machine Settings alone.
- The `machine-software` still runs to the bottom of the Skins card, and shows what the simulated tablet reports: Decaid's bundled Skins, DYE2 and the plugin.

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
- It is cropped to 482 px tall at that width, which drops the sliver of the Weight chart's legend the clip leaves. Recheck that height (`GIF_HEIGHT` in `stills.ts`) when the card's layout changes: the spec fails when the clip, scaled to the GIF's width, is shorter.
- It ends on the last frame captured before the recording turns Idle, about 38.3 s into the capture, and holds it 6 s. After that the recording shows Idle, the scale at -189 g as the cup is lifted, and "Waiting for its Shot", which reads as a bug.
- The spec writes when the recording turns Idle into `capture.json` beside the frames, and `encode.mjs` cuts there.
- `getByRole("figure", { name })` matches a case-insensitive substring, so the Live View's `"Weight"` lookups take `exact: true`, or they would match the Weight flow chart too.
- The phone still is the Live View in a 390 x 844 viewport, mid-pour.

## A fresh sample

The committed sample is enough unless the curves need replacing.

```bash
SAMPLE_SERVER=<server URL> SAMPLE_EMAIL=<Admin email> SAMPLE_PASSWORD=<password> \
  node scripts/images/sample.mjs <file>
```

- Sample only a server whose owner agrees to its Shots' curves being published.
- It signs in, makes only `GET` requests, and signs out.
- It keeps up to 24 espresso Shots of 18 to 60 s, at most 4 a profile, and only their physics: profile steps, curves, dose, yield and stop reason.
- It moves each Shot's samples by a whole number of milliseconds so the earliest falls in the first millisecond of 2000-01-01T00:00:00, keeping every interval between samples as recorded.
- Check every key and string in the file before committing it: the repo is public.
- A profile's title and step names come from whoever wrote it. A profile bundled with Decaid (`decaid:assets/defaultProfiles/`) names no one; give any other a made-up neutral title, in the file and wherever the spec names it.
- It prints the profiles in the order kept: recheck the spec's `sample[n]` indexes against them, and Downtown's arithmetic.
