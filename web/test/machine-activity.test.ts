import { afterEach, describe, expect, it, vi } from "vitest";
import type { TrailEntry, WorkflowSummary } from "../src/lib/api";
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

  it("reads a time in the zone of the Location the Machine was at then, by its Location History, and UTC's before its first", () => {
    expect(timeZoneAt(history, "2024-12-31T23:59:59Z")).toBe("UTC");
    expect(timeZoneAt(history, "2025-01-01T00:00:00Z")).toBe("America/Denver");
    expect(timeZoneAt(history, "2026-02-10T19:59:59Z")).toBe("America/Denver");
    expect(timeZoneAt(history, "2026-02-10T20:00:00Z")).toBe("Asia/Tokyo");
    expect(timeZoneAt([], "2026-02-10T20:00:00Z")).toBe("UTC");
  });

  it("shows a time of the day chosen as its time there alone, to the second, with its zone, and one of another day with its date, whatever the browser's time zone", () => {
    for (const browser of ["UTC", "Australia/Sydney"]) {
      vi.stubEnv("TZ", browser);
      // The 10th at the Lab: a Shot at 08:00:10, and the sleep it began in, from 22:00 the evening before.
      expect(whenText("2026-02-10T15:00:10Z", "2026-02-10", history), browser).toBe("8:00:10 AM MST");
      expect(whenText("2026-02-10T05:00:00Z", "2026-02-10", history), browser).toBe("Feb 9, 2026, 10:00:00 PM MST");
      // The 11th is the Harbor's: a flush there at 06:00, and its waking at the Lab, at 11:00 on the 10th there.
      expect(whenText("2026-02-10T21:00:00Z", "2026-02-11", history), browser).toBe("6:00:00 AM GMT+9");
      expect(whenText("2026-02-10T18:00:00Z", "2026-02-11", history), browser).toBe("Feb 10, 2026, 11:00:00 AM MST");
      // Before it was anywhere, UTC's.
      expect(whenText("2024-12-30T12:00:00Z", "2024-12-30", history), browser).toBe("12:00:00 PM UTC");
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

  it("gives an item changed under an unchanged name as its kind, each side linked", () => {
    // The next batch of the same Bean, and a batch where the Workflow named none.
    expect(lines(change("beanBatchId", "b1", "b2"))).toEqual([
      { label: "Bean Batch", before: { text: "The previous one", to: "/library/bean-batches/b1" }, after: { text: "The new one", to: "/library/bean-batches/b2" } },
    ]);
    expect(lines(change("beanBatchId", null, "b2"), change("dose", 18, 19))).toEqual([
      { label: "Bean Batch", before: { text: "None" }, after: { text: "The new one", to: "/library/bean-batches/b2" } },
      { label: "Dose", before: { text: "18 g" }, after: { text: "19 g" } },
    ]);
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
});
