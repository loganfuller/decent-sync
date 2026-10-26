export declare const manifestName: string;

export type Manifest = Record<string, number>;
export interface TestFile {
  path: string;
  project: string;
  size: number;
}
export interface Estimated {
  path: string;
  seconds: number;
}

export declare function readManifest(root: string): Manifest;
export declare function writeManifest(root: string, durations: Manifest): void;
export declare function estimateDurations<T extends TestFile>(files: T[], manifest: Manifest, root: string): (T & Estimated)[];
export declare function longestFirst(a: Estimated, b: Estimated): number;
export declare function dealOut<T extends Estimated>(files: T[], count: number): T[][];
export declare function readRunLog(log: string): Map<string, number>;
export declare function median(values: number[]): number | undefined;
