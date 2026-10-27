export declare const BUILD_COMMAND: string;
export declare const RELEASE_TAG: RegExp;

export declare function latestReleaseTag(root?: string): string;
export declare function releasesDir(): string;
export declare function releaseDir(tag: string): string;
export declare function latestReleaseDir(root?: string): string;
export declare function buildsToRemove(entries: readonly string[], built: string): string[];
export declare function compareVersions(a: string, b: string): number;
export declare function wireRevisionIn(source: string): number | undefined;
export declare function releaseWireRevision(tag: string, root?: string): number;
