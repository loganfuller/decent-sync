export declare const repoDir: string;

export declare const BUILDS: {
  readonly protocol: BuildEntry;
  readonly plugin: BuildEntry;
  readonly web: BuildEntry;
  readonly server: BuildEntry;
};
export interface BuildEntry {
  outputs: string[];
  sources: string[];
  ignore?: string;
}
export type Build = keyof typeof BUILDS;
export interface StaleBuild {
  build: Build;
  reason: string;
}

export declare function staleness(build: Build, root?: string): string | undefined;
export declare function staleBuilds(root?: string): StaleBuild[];
export declare function rebuildCommand(builds: readonly Build[]): string;
