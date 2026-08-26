import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  STANDALONE_FACADES,
  STANDALONE_WORKER_CLIENT_FACADES,
  createStandaloneFacadeAliases,
} from './standalone-facades.js';

describe('standalone facades', () => {
  it('keeps every configured standalone target present in the source tree', () => {
    const missingTargets = STANDALONE_FACADES
      .map(({ standalonePath }) => standalonePath)
      .filter(standalonePath => !existsSync(resolve(process.cwd(), standalonePath)));

    expect(missingTargets).toEqual([]);
  });

  it('routes the HizoFS benchmark client through its standalone facade', () => {
    const facadePath = '@/features/debug-hizofs/benchmark/client';
    const standalonePath = 'src/features/debug-hizofs/benchmark/client-standalone.ts';
    expect(STANDALONE_WORKER_CLIENT_FACADES).toContain(facadePath);

    const aliases = createStandaloneFacadeAliases({
      resolvePath: relativePath => resolve(process.cwd(), relativePath),
    });
    const alias = aliases.find(({ find }) => (
      find instanceof RegExp && find.test(facadePath)
    ));

    expect(alias?.replacement).toBe(resolve(process.cwd(), standalonePath));
  });

  it('keeps the manager behind the exact facade instead of importing hosted UI directly', () => {
    const managerSource = readFileSync(
      resolve(process.cwd(), 'src/features/transformers-js/components/TransformersJsManager.vue'),
      'utf8',
    );
    const standaloneSource = readFileSync(
      resolve(process.cwd(), 'src/features/transformers-js/model-support-investigation/index-standalone.ts'),
      'utf8',
    );

    expect(managerSource).toContain("from '@/features/transformers-js/model-support-investigation'");
    expect(managerSource).not.toContain('model-support-investigation/components/ModelSupportInvestigationModal.vue');
    expect(standaloneSource).not.toContain('ModelSupportInvestigationModal.vue');
  });

  it('replaces the model support investigation facade with its standalone implementation', () => {
    const facadePath = '@/features/transformers-js/model-support-investigation';
    const expectedStandalonePath = 'src/features/transformers-js/model-support-investigation/index-standalone.ts';
    const definition = STANDALONE_FACADES.find((facade) => facade.facadePath === facadePath);

    expect(definition).toEqual({ facadePath, standalonePath: expectedStandalonePath });

    const aliases = createStandaloneFacadeAliases({ resolvePath: (path) => `/repo/${path}` });
    const alias = aliases.find(({ find }) => find instanceof RegExp && find.test(facadePath));

    expect(alias).toEqual({
      find: expect.any(RegExp),
      replacement: `/repo/${expectedStandalonePath}`,
    });
    expect((alias?.find as RegExp).test(`${facadePath}/components/ModelSupportInvestigationModal.vue`)).toBe(false);
  });
});
