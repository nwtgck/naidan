import type { Alias } from 'vite';

export interface StandaloneFacade {
  readonly facadePath: string,
  readonly standalonePath: string,
}

export declare const STANDALONE_FACADES: readonly StandaloneFacade[];

export declare const STANDALONE_WORKER_CLIENT_FACADES: readonly string[];

export declare function createStandaloneFacadeAliases({
  resolvePath,
}: {
  resolvePath: (relativePath: string) => string,
}): Alias[];
