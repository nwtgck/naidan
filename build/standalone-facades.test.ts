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

  it('routes HizoFS inspection through the standalone worker hub facade', () => {
    const hizoFSFacade = '@/features/debug-hizofs/worker/client';
    expect(STANDALONE_WORKER_CLIENT_FACADES).toContain(hizoFSFacade);

    const aliases = createStandaloneFacadeAliases({
      resolvePath: relativePath => resolve(process.cwd(), relativePath),
    });
    const alias = aliases.find(({ find }) => (
      find instanceof RegExp && find.test(hizoFSFacade)
    ));

    expect(alias?.replacement).toBe(resolve(
      process.cwd(),
      'src/features/debug-hizofs/worker/client-standalone.ts',
    ));
  });
});
