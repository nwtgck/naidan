import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  STANDALONE_FACADES,
  STANDALONE_WORKER_CLIENT_FACADES,
  createStandaloneFacadeAliases,
} from './standalone-facades.js';

describe('standalone facade aliases', () => {
  it('keeps every configured standalone target present in the source tree', () => {
    const missingTargets = STANDALONE_FACADES
      .map(({ standalonePath }) => standalonePath)
      .filter(standalonePath => !existsSync(resolve(process.cwd(), standalonePath)));

    expect(missingTargets).toEqual([]);
  });

  it.each([
    [
      '@/features/debug-hizofs/benchmark/client',
      'src/features/debug-hizofs/benchmark/client-standalone.ts',
    ],
  ] as const)('routes %s through the standalone worker hub facade', (facadePath, standalonePath) => {
    expect(STANDALONE_WORKER_CLIENT_FACADES).toContain(facadePath);

    const aliases = createStandaloneFacadeAliases({
      resolvePath: relativePath => resolve(process.cwd(), relativePath),
    });
    const alias = aliases.find(({ find }) => (
      find instanceof RegExp && find.test(facadePath)
    ));

    expect(alias?.replacement).toBe(resolve(process.cwd(), standalonePath));
  });
});
