export declare const CONSTRUCTORS: readonly ["_Wallet", "_ReadonlyWallet"];
export interface ConstructionHits { text: string; hits: Record<string, number>; already: number }
export declare function patchConstruction(source: string): ConstructionHits;
export declare function assertBundleSites(file: string, result: ConstructionHits): 'already' | 'patched';
export declare function patchSdk(directory: string): { patched: number; supported: number; bundles: number; already: number };
