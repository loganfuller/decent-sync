export declare const SET_HOURS: number;
export declare const DECAID_MODELS: readonly string[];
export declare const STOP_REASONS: readonly string[];

export interface CorpusShot {
  model: string;
  dose: number | null;
  yield: number | null;
  stopReason: string | null;
  tea?: true;
  set?: string;
  profile: Record<string, unknown> & { steps: Array<Record<string, unknown>> };
  samples: Record<"seconds" | "frame" | "pressure" | "flow" | "targetPressure" | "targetFlow" | "weight", Array<number | null>>;
}

export declare function scrubShot(file: unknown, set?: string | null): CorpusShot | string;
export declare function corpusProblems(shot: unknown): string[];
export declare function inferSets(files: Array<{ shot: Record<string, unknown> }>, excluded?: string[]): string[][];
