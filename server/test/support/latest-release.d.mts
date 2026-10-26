export declare const BUILD_COMMAND: string;
export declare const RELEASE_TAG: RegExp;

export declare function latestReleaseTag(root?: string): string;
export declare function releasesDir(): string;
export declare function releaseDir(tag: string): string;
export declare function latestReleaseDir(root?: string): string;
