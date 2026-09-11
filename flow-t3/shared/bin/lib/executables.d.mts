export interface DiscoveryOptions { home?: string; env?: NodeJS.ProcessEnv; platform?: string; accept?: (file: string) => boolean }
export function executableFile(file: string): boolean;
export function executableCandidates(command: string, options?: DiscoveryOptions): string[];
export function rememberExecutable(command: string, file: string, options?: DiscoveryOptions): void;
export function discoverExecutable(command: string, options?: DiscoveryOptions): string | null;
