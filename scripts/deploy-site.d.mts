export declare function minorOf(version: string): string;
export declare function deployedMinors(pagesDir: string): string[];
export declare function deploy(pagesDir: string, version: string, build: (base: string) => string): { minor: string; latest: boolean };
