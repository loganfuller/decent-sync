export declare const MARGIN_SHARE: number;
export declare const MARGIN_SECONDS: number;
export declare const MARGIN_BAR: number;
export declare const STEP_SECONDS: number;
export declare const PROFILE_KINDS: readonly string[];

export interface ShotEntry {
  name: string;
  record: unknown;
  measurements: unknown;
  tea: boolean;
  set: string | null;
}
export interface Spread {
  median: number | null;
  worstTenth: number | null;
}
export interface FigureErrors {
  duration: number;
  durationShare: number | null;
  timeToFirstDrip: number | null;
  peakPressure: number;
}
export interface ScoredShot {
  name: string;
  model: "DE1" | "Bengle" | null;
  tea: boolean;
  set: string | null;
  kind: string | null;
  noCoffee: boolean;
  manual: boolean;
  noFit: string | null;
  errors: FigureErrors | null;
  within: boolean;
  stepsAlike: boolean;
  curves: { pressure: number | null; flow: number | null; weight: number | null } | null;
}
export interface Summary {
  shots: number;
  fitted: number;
  within: number;
  share: number | null;
  duration: Spread;
  timeToFirstDrip: Spread;
  peakPressure: Spread;
  stepsAlike: number | null;
  curves: { pressure: number | null; flow: number | null; weight: number | null };
}
export interface PairSummary {
  pairs: number;
  within: number;
  duration: Spread;
  peakPressure: Spread;
}
export interface SetPair {
  set: string;
  from: string;
  to: string;
  model: "DE1" | "Bengle";
  same: boolean;
  errors: FigureErrors;
  within: boolean;
}
export interface SetSummary {
  model: "DE1" | "Bengle";
  shots: number;
  same: PairSummary;
  different: PairSummary;
}
export interface Scorecard {
  shots: ScoredShot[];
  models: Partial<Record<"DE1" | "Bengle", { all: Summary; kinds: Record<string, Summary> }>>;
  tea: Summary;
  unreadable: number;
  noModel: number;
  noCoffee: number;
  manual: number;
  sets: { same: PairSummary; different: PairSummary; bySet: Record<string, SetSummary>; pairs: SetPair[] };
}

export declare const NO_COFFEE_BAR: number;
export declare const NO_COFFEE_GRAMS: number;
export declare function metNoCoffee(samples: unknown[]): boolean;
export declare function readShots(dir: string): ShotEntry[];
export declare function shotEntry(name: string, file: unknown): ShotEntry;
export declare function isTea(title: unknown): boolean;
export declare function corpusRecord(shot: unknown): { record: unknown; measurements: unknown[] };
export declare function profileKind(profile: unknown, samples: unknown[]): string;
export declare function scoreShot(entry: ShotEntry): ScoredShot;
export declare function scorecard(entries: ShotEntry[]): Scorecard;
export declare function formatScorecard(card: Scorecard): string;
export declare function formatSetPairs(card: Scorecard, set: string): string | null;
export declare function setPairs(entries: ShotEntry[]): SetPair[];
export declare function spread(values: number[]): Spread;
