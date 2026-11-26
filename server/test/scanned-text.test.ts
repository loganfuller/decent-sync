import { describe, expect, it } from "vitest";
import { codeCandidates, datesIn, namesBean, scannedWords } from "../src/library/scanned-text.js";

// How the text of a scanned QR code is read (ticket #708): what in it may be
// a Batch Code, the dates in it, and whether it names a Bean. Matching
// against the Library is tested through the plugin's request
// (skin-batch-scans.test.ts).

describe("What in scanned text may be a Batch Code", () => {
  it("is a URL's last path segment, its query values and its fragment, each decoded and trimmed", () => {
    expect(codeCandidates("https://roaster.example/batches/PR-0470?lot=A%2012&empty=#frag%20ment")).toEqual(["PR-0470", "A 12", "frag ment"]);
    expect(codeCandidates("https://roaster.example/batches/PR-0470/")).toEqual(["PR-0470"]);
    expect(codeCandidates("roastlog://batch/%20PR-0470%20")).toEqual(["PR-0470"]);
    expect(codeCandidates("https://roaster.example")).toEqual([]);
    // Percent-escapes that can't be read are left as they are.
    expect(codeCandidates("https://roaster.example/100%25/PR%ZZ")).toEqual(["PR%ZZ"]);
  });

  it("is each string value of JSON, at any depth, and no key or number", () => {
    expect(codeCandidates('{"roaster":"Roux","batch":{"code":" PR-0470 ","kg":6},"tags":["a",["b"]]}')).toEqual(["Roux", "PR-0470", "a", "b"]);
    expect(codeCandidates('"PR-0470"')).toEqual(["PR-0470"]);
    expect(codeCandidates("470")).toEqual([]);
    expect(codeCandidates("{not json")).toEqual([]);
  });

  it("is nothing for text that is neither, though it parses as a URL of a scheme of its own", () => {
    for (const text of ["PR-0470", "Roaster: PR-0470", "mailto:roaster@example.com", "roux guji"]) expect(codeCandidates(text)).toEqual([]);
  });

  it("leaves out a value longer than a Batch Code, or one PostgreSQL would not store", () => {
    expect(codeCandidates(JSON.stringify(["x".repeat(101), "x".repeat(100)]))).toEqual(["x".repeat(100)]);
    expect(codeCandidates("https://roaster.example/PR-0470?extra=%00")).toEqual(["PR-0470"]);
    expect(codeCandidates(String.raw`["PR-0470","a\u0000b","\ud800"]`)).toEqual(["PR-0470"]);
  });

  it("reads every value, however many come before a code and however deep it is", () => {
    const many = Array.from({ length: 80 }, (_, index) => `code-${index}`);
    expect(codeCandidates(JSON.stringify(many))).toEqual(many);
    const deep = JSON.stringify(Array.from({ length: 20 }).reduce<unknown>((inner) => [inner], "PR-0470"));
    expect(codeCandidates(deep)).toEqual(["PR-0470"]);
  });
});

describe("The dates in scanned text", () => {
  it("are read year first, or with the month by name, and taken out of the text", () => {
    expect(datesIn("Guji 2026-11-20")).toEqual({ dates: ["2026-11-20"], rest: "Guji  " });
    for (const text of ["2026/11/20", "2026.11.20", "2026-11-20", "2026-1-5 and 2026-01-05", "20 Nov 2026", "20th November 2026", "Nov 20, 2026", "November 20th 2026", "nov. 20 2026", "20-Nov-2026"]) {
      expect(datesIn(text).dates, text).toEqual([text.startsWith("2026-1-5") ? "2026-01-05" : "2026-11-20"]);
    }
    expect(datesIn("roasted 2026-11-20, best before 2027-02-20").dates).toEqual(["2026-11-20", "2027-02-20"]);
  });

  it("are not guessed: none with the year last in numbers, none of eight digits run together, and none the calendar doesn't have", () => {
    for (const text of ["11/20/2026", "20/11/2026", "20.11.26", "20261120", "2026-13-01", "2026-02-30", "31 Nov 2026", "12026-11-201", "Mayor 20, 2026"]) {
      expect(datesIn(text), text).toEqual({ dates: [], rest: text });
    }
  });
});

describe("Whether scanned text names a Bean", () => {
  const guji = { roaster: "Roux", name: "Guji Natural" };
  const names = (text: string, bean: { roaster: string | null; name: string | null } = guji) => namesBean(scannedWords(text), bean);

  it("does where every word of the text is in the Bean's roaster and name, whatever its case and punctuation, its dates aside", () => {
    for (const text of ["Roux Guji Natural", "guji", "ROUX: natural", "Guji 2026-11-20", "Guji, Guji"]) expect(names(text), text).toBe(true);
    for (const text of ["Roux Guji Washed", "Guj", "Roux Kenya"]) expect(names(text), text).toBe(false);
  });

  it("does where every word of the Bean's name is in the text, among whatever else it holds", () => {
    for (const text of ["Roux Coffee - Guji Natural - 250 g", "https://roaster.example/coffees/guji-natural?roast=2026-11-20", '{"coffee":"Guji Natural","kg":6}']) expect(names(text), text).toBe(true);
    expect(names("Roux Coffee - Guji - 250 g")).toBe(false);
  });

  it("names none with no words of its own, and never a Bean with no name by the text holding it", () => {
    for (const text of ["", "  ", "2026-11-20", "---"]) expect(names(text), JSON.stringify(text)).toBe(false);
    expect(names("anything at all", { roaster: "Roux", name: null })).toBe(false);
    expect(names("Roux", { roaster: "Roux", name: null })).toBe(true);
    expect(names("Guji", { roaster: null, name: "Guji" })).toBe(true);
  });
});
