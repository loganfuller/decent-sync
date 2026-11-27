import { afterEach, describe, expect, it, vi } from "vitest";
import type { BatchLink, TrailEntry, WorkflowSummary } from "../src/lib/api";
import { batchLineText, roastedText } from "../src/lib/batch-name";
import { dateIn, madeBy, timeZoneAt, trailLines, whenText } from "../src/lib/machine-activity";

// How a Machine's activity reads on its page (#476).

const change = (field: string, before: string | number | null, after: string | number | null) => ({ field, before, after });

/** A Workflow's summary holding nothing, but for what is given. */
const summary = (held: Partial<WorkflowSummary> = {}): WorkflowSummary => ({
  profile: null,
  profileId: null,
  brewTemperature: null,
  dose: null,
  yield: null,
  bean: null,
  roaster: null,
  beanBatchId: null,
  grinder: null,
  burrs: null,
  grindSetting: null,
  grinderId: null,
  basket: null,
  basketId: null,
  recipe: null,
  recipeId: null,
  barista: null,
  steam: null,
  hotWater: null,
  flush: null,
  ...held,
});

/** A changed entry's lines. */
const lines = (...changes: TrailEntry["changes"]) => trailLines({ workflow: null, changes });

/** A Bean Batch as the server names one (#732). */
const batchOf = (id: string, bean: { id: string; name: string | null }, roastDate: string | null, batchCode: string | null): BatchLink => ({ id, bean: { ...bean, roaster: "Lantern" }, roastDate, batchCode });
const HOUSE = { id: "bean-house", name: "House Espresso" };
const DECAF = { id: "bean-decaf", name: "Decaf Colombia" };
const earlier = batchOf("b1", HOUSE, "2026-11-10T00:00:00.000", "LR-0405");
const later = batchOf("b2", HOUSE, "2026-11-17T00:00:00.000", "LR-0411");
const uncoded = batchOf("b3", HOUSE, "2026-11-03T00:00:00.000", null);
const decaf = batchOf("b4", DECAF, "2026-11-13T00:00:00.000", null);
/** A change of the batch a Workflow names, with the batch the server names on each side. */
const batchChange = (before: BatchLink | null, after: BatchLink | null) => ({ field: "beanBatchId", before: before?.id ?? null, after: after?.id ?? null, beanBatch: { before, after } });
/** A batch as a line's value: in a line, or brief, by its code alone or its roast date. */
const inLine = (batch: BatchLink) => ({ text: batchLineText(batch), to: `/library/bean-batches/${batch.id}`, batch: { batch, brief: false } });
const brief = (batch: BatchLink) => ({ text: batch.batchCode ?? roastedText(batch), to: `/library/bean-batches/${batch.id}`, batch: { batch, brief: true } });

describe("a Machine's activity as its page shows it", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("takes today as the date on the wall clock of the Machine's Location, UTC's for none or for a zone it doesn't know", () => {
    // 04:30 on 11 November in UTC: still the 10th in Denver, and already the afternoon of the 11th in Tokyo.
    const now = Date.parse("2026-11-11T04:30:00Z");
    expect(dateIn("America/Denver", now)).toBe("2026-11-10");
    expect(dateIn("Asia/Tokyo", now)).toBe("2026-11-11");
    expect(dateIn(undefined, now)).toBe("2026-11-11");
    expect(dateIn("Mars/Olympus_Mons", now)).toBe("2026-11-11");
  });

  // At the Lab, in Denver, from 2025, and at the Harbor, in Tokyo, from 13:00 on 10 February 2026 at the Lab.
  const history = [
    { effectiveFrom: "2025-01-01T00:00:00.000Z", location: { id: "lab", name: "Lab", timeZone: "America/Denver" } },
    { effectiveFrom: "2026-02-10T20:00:00.000Z", location: { id: "harbor", name: "Harbor", timeZone: "Asia/Tokyo" } },
  ];

  it("reads a time in the zone of the Location the Machine was at then, by its Location History, its first's from the start of the day it came there, and UTC's before that day", () => {
    // It came to the Lab at 17:00 on 31 December there (#587): that day there began at 07:00 in UTC.
    expect(timeZoneAt(history, "2024-12-31T06:59:59Z")).toBe("UTC");
    expect(timeZoneAt(history, "2024-12-31T07:00:00Z")).toBe("America/Denver");
    expect(timeZoneAt(history, "2024-12-31T23:59:59Z")).toBe("America/Denver");
    expect(timeZoneAt(history, "2025-01-01T00:00:00Z")).toBe("America/Denver");
    expect(timeZoneAt(history, "2026-02-10T19:59:59Z")).toBe("America/Denver");
    expect(timeZoneAt(history, "2026-02-10T20:00:00Z")).toBe("Asia/Tokyo");
    expect(timeZoneAt([], "2026-02-10T20:00:00Z")).toBe("UTC");
  });

  it("shows a time of the day chosen as its time there alone, to the second, with its zone, and one of another day with its date, whatever the browser's time zone", () => {
    // In whatever locale this runs, as web/test/machine-use.test.ts reads a day: an hour may be 8 or 08, 10 PM or 22.
    // Sydney first: a format is kept once made, so one made with no zone under UTC would go on reading as UTC's.
    for (const browser of ["Australia/Sydney", "UTC"]) {
      vi.stubEnv("TZ", browser);
      // The 10th at the Lab: a Shot at 08:00:10, and the sleep it began in, from 22:00 on the 9th.
      const shot = whenText("2026-02-10T15:00:10Z", "2026-02-10", history);
      expect(shot, browser).toMatch(/^0?8:00:10\b/);
      expect(shot, browser).not.toMatch(/2026/);
      // With the Lab's zone, as a locale names it.
      expect(shot, browser).toMatch(/(MST|GMT-7|UTC−7)$/);
      const asleep = whenText("2026-02-10T05:00:00Z", "2026-02-10", history);
      expect(asleep, browser).toMatch(/\b9\b.*2026.*\b(10|22):00:00\b/);
      // The 11th is the Harbor's: a flush there at 06:00, and its waking at the Lab, at 11:00 on the 10th there.
      const flush = whenText("2026-02-10T21:00:00Z", "2026-02-11", history);
      expect(flush, browser).toMatch(/^0?6:00:00\b/);
      expect(flush, browser).not.toMatch(/2026/);
      expect(whenText("2026-02-10T18:00:00Z", "2026-02-11", history), browser).toMatch(/\b10\b.*2026.*\b11:00:00\b/);
      // Before it was anywhere, UTC's.
      expect(whenText("2024-12-30T12:00:00Z", "2024-12-30", history), browser).toMatch(/^12:00:00\b.*UTC$/);
      // At a Location whose time zone the browser doesn't know, UTC's too, as its day is.
      const unknown = [{ effectiveFrom: "2025-01-01T00:00:00.000Z", location: { id: "mars", name: "Mars", timeZone: "Mars/Olympus_Mons" } }];
      expect(whenText("2026-02-10T15:00:10Z", "2026-02-10", unknown), browser).toMatch(/^(3|15):00:10\b.*UTC$/);
    }
  });

  it("says who made a change: Decent Sync, with which of its writes, the tablet for anyone else, or nobody recorded", () => {
    expect(madeBy({ cause: "other", pluginWrite: null })).toBe("The tablet");
    expect(madeBy({ cause: "unknown", pluginWrite: null })).toBe("Not recorded");
    expect(madeBy({ cause: "plugin", pluginWrite: "load" })).toBe("Decent Sync, loading the Recipe");
    expect(madeBy({ cause: "plugin", pluginWrite: "loadedRecipe" })).toBe("Decent Sync, from an edit made elsewhere");
    expect(madeBy({ cause: "plugin", pluginWrite: "steamOn" })).toBe("Decent Sync, turning steam back on");
    // A write a later release names, and one the server names none of.
    expect(madeBy({ cause: "plugin", pluginWrite: "descale" })).toBe("Decent Sync");
    expect(madeBy({ cause: "plugin", pluginWrite: null })).toBe("Decent Sync");
  });

  it("gives each field that changed from what to what, with its unit, in the order changed, a part's by its own name and a field it doesn't know by the summary's", () => {
    expect(lines(change("grindSetting", "3", "2.8"), change("dose", 18, 18.5), change("steam.duration", 50, null), change("brewTemperature", null, 93), change("preinfusion.flow", 4, 4.5))).toEqual([
      { label: "Grind setting", before: { text: "3" }, after: { text: "2.8" } },
      { label: "Dose", before: { text: "18 g" }, after: { text: "18.5 g" } },
      { label: "Steam time", before: { text: "50 s" }, after: { text: "None" } },
      { label: "Brew temperature", before: { text: "None" }, after: { text: "93 °C" } },
      { label: "preinfusion.flow", before: { text: "4" }, after: { text: "4.5" } },
    ]);
  });

  it("links a Library item named anew on one line, each side to the item the Workflow named then, if any", () => {
    // A Profile switched for another, both the Library's; and a Recipe loaded where there was none.
    expect(lines(change("profileId", "profile:aa", "profile:bb"), change("profile", "Adaptive", "Classic"), change("recipe", null, "House"), change("recipeId", null, "r1"))).toEqual([
      { label: "Profile", before: { text: "Adaptive", to: "/library/profiles/profile%3Aaa" }, after: { text: "Classic", to: "/library/profiles/profile%3Abb" } },
      { label: "Recipe", before: { text: "None", to: undefined }, after: { text: "House", to: "/library/recipes/r1" } },
    ]);
    // A Grinder the tablet names that never joined the Library has no page, and a Recipe with no name is named by its kind.
    expect(lines(change("grinder", "Mazzer", "EK43"), change("grinderId", "g1", null), change("recipe", "House", null), change("recipeId", "r1", "r2"))).toEqual([
      { label: "Grinder", before: { text: "Mazzer", to: "/library/grinders/g1" }, after: { text: "EK43", to: undefined } },
      { label: "Recipe", before: { text: "House", to: "/library/recipes/r1" }, after: { text: "Unnamed Recipe", to: "/library/recipes/r2" } },
    ]);
    // A name that changed with no change of item gives no id, so no link.
    expect(lines(change("basket", "18 g", "20 g"))).toEqual([{ label: "Basket", before: { text: "18 g", to: undefined }, after: { text: "20 g", to: undefined } }]);
  });

  it("gives an item changed under an unchanged name as its kind, each side linked, as it does a Bean Batch the previous release's server leaves unnamed (ADR-0025)", () => {
    // A Grinder of the same model, and a Basket where the Workflow named none.
    expect(lines(change("grinderId", "g1", "g2"))).toEqual([
      { label: "Grinder", before: { text: "The previous one", to: "/library/grinders/g1" }, after: { text: "The new one", to: "/library/grinders/g2" } },
    ]);
    expect(lines(change("basketId", null, "k2"), change("dose", 18, 19))).toEqual([
      { label: "Basket", before: { text: "None" }, after: { text: "The new one", to: "/library/baskets/k2" } },
      { label: "Dose", before: { text: "18 g" }, after: { text: "19 g" } },
    ]);
    // The previous release's server names no batch on a change of one, so the page reads as it did.
    expect(lines(change("beanBatchId", "b1", "b2"))).toEqual([
      { label: "Bean Batch", before: { text: "The previous one", to: "/library/bean-batches/b1" }, after: { text: "The new one", to: "/library/bean-batches/b2" } },
    ]);
    expect(lines(change("bean", "Decaf Colombia", "House Espresso"), change("beanBatchId", "b4", "b1"))).toEqual([
      { label: "Bean", before: { text: "Decaf Colombia", to: "/library/bean-batches/b4" }, after: { text: "House Espresso", to: "/library/bean-batches/b1" } },
    ]);
  });

  it("names both batches of a change to the next roast of the same Bean by their Batch Codes alone, or by a roast date where a batch has none (#732)", () => {
    expect(lines(batchChange(earlier, later), change("grindSetting", "2.2", "2.4"))).toEqual([
      { label: "Bean Batch", before: brief(earlier), after: brief(later) },
      { label: "Grind setting", before: { text: "2.2" }, after: { text: "2.4" } },
    ]);
    expect(lines(batchChange(earlier, later))[0]).toMatchObject({ before: { text: "LR-0405" }, after: { text: "LR-0411" } });
    // One with no code, by its roast date.
    expect(lines(batchChange(uncoded, later))).toEqual([{ label: "Bean Batch", before: brief(uncoded), after: brief(later) }]);
    expect(lines(batchChange(uncoded, later))[0]!.before!.text).toBe(roastedText(uncoded));
    // Never as the previous one and the new one.
    expect(JSON.stringify(lines(batchChange(earlier, later)))).not.toMatch(/The previous one|The new one/);
  });

  it("names each batch of a change of Bean in a line, on one line named Bean Batch, whichever of its name and its batch changed first", () => {
    const expected = [{ label: "Bean Batch", before: inLine(decaf), after: inLine(earlier) }, { label: "Dose", before: { text: "18 g" }, after: { text: "20 g" } }];
    expect(lines(change("bean", "Decaf Colombia", "House Espresso"), batchChange(decaf, earlier), change("dose", 18, 20))).toEqual(expected);
    expect(lines(batchChange(decaf, earlier), change("bean", "Decaf Colombia", "House Espresso"), change("dose", 18, 20))).toEqual(expected);
    expect(expected[0]!.before).toMatchObject({ text: `Decaf Colombia, ${roastedText(decaf)}` });
    expect(expected[0]!.after).toMatchObject({ text: "House Espresso LR-0405" });
    // Two Beans of one name, as the Workflow recorded them, are two Beans: each side in a line.
    const namesake = batchOf("b5", { id: "bean-other", name: "House Espresso" }, "2026-11-20T00:00:00.000", "XX-1");
    expect(lines(batchChange(earlier, namesake))).toEqual([{ label: "Bean Batch", before: inLine(earlier), after: inLine(namesake) }]);
  });

  it("gives a side of a change of Bean Batch that names no batch as the coffee the Workflow recorded then, or as none", () => {
    // A batch picked where the Workflow named a coffee of no batch, and where it named none; and a batch cleared.
    expect(lines(change("bean", "Guest Kenya", "House Espresso"), batchChange(null, later))).toEqual([{ label: "Bean Batch", before: { text: "Guest Kenya" }, after: inLine(later) }]);
    expect(lines(change("bean", null, "House Espresso"), batchChange(null, later))).toEqual([{ label: "Bean Batch", before: { text: "None" }, after: inLine(later) }]);
    expect(lines(batchChange(null, later))).toEqual([{ label: "Bean Batch", before: { text: "None" }, after: inLine(later) }]);
    expect(lines(batchChange(later, null))).toEqual([{ label: "Bean Batch", before: inLine(later), after: { text: "None" } }]);
  });

  it("gives the Workflow in effect as the fields it holds, in the page's order, the Library items it names linked", () => {
    const held = summary({
      profile: "Adaptive",
      profileId: "profile:aa",
      brewTemperature: 93,
      dose: 18,
      yield: 36,
      bean: "Guji",
      roaster: "Roux",
      beanBatchId: "b1",
      grinder: "EK43",
      grindSetting: "8.8",
      basket: "18 g",
      recipeId: "r1",
      steam: { temperature: 160, duration: 25, flow: null },
      flush: { temperature: null, duration: 5 },
    });
    expect(trailLines({ workflow: held, changes: [] })).toEqual([
      // A Recipe with no name, by its kind; a Grinder and a Basket not the Library's, without a page.
      { label: "Recipe", after: { text: "Unnamed Recipe", to: "/library/recipes/r1" } },
      { label: "Profile", after: { text: "Adaptive", to: "/library/profiles/profile%3Aaa" } },
      { label: "Brew temperature", after: { text: "93 °C" } },
      { label: "Dose", after: { text: "18 g" } },
      { label: "Yield", after: { text: "36 g" } },
      { label: "Bean", after: { text: "Guji", to: "/library/bean-batches/b1" } },
      { label: "Roaster", after: { text: "Roux" } },
      { label: "Grinder", after: { text: "EK43", to: undefined } },
      { label: "Grind setting", after: { text: "8.8" } },
      { label: "Basket", after: { text: "18 g", to: undefined } },
      { label: "Steam temperature", after: { text: "160 °C" } },
      { label: "Steam time", after: { text: "25 s" } },
      { label: "Flush time", after: { text: "5 s" } },
    ]);
    expect(trailLines({ workflow: summary(), changes: [] })).toEqual([]);
  });

  it("gives the Workflow in effect its Bean Batch in a line of its own, under its Bean and roaster as it recorded them, where the server names the batch (#732)", () => {
    const named = trailLines({ workflow: summary({ bean: "House Espresso", roaster: "Lantern", beanBatchId: later.id, beanBatch: later, grinder: "EK43" }), changes: [] });
    expect(named).toEqual([
      { label: "Bean", after: { text: "House Espresso" } },
      { label: "Roaster", after: { text: "Lantern" } },
      { label: "Bean Batch", after: inLine(later) },
      { label: "Grinder", after: { text: "EK43", to: undefined } },
    ]);
    // A Workflow that recorded no coffee's name or roaster still names its batch, and one naming none has no such line.
    expect(trailLines({ workflow: summary({ beanBatchId: decaf.id, beanBatch: decaf }), changes: [] })).toEqual([{ label: "Bean Batch", after: inLine(decaf) }]);
    expect(trailLines({ workflow: summary({ bean: "Guest Kenya", beanBatch: null }), changes: [] })).toEqual([{ label: "Bean", after: { text: "Guest Kenya", to: undefined } }]);
  });
});
