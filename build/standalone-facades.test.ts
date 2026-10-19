import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createStandaloneFacadeAliases, STANDALONE_FACADES } from './standalone-facades.js';

describe('standalone facades', () => {
  it('replaces the browser model download boundary without importing its hosted worker', () => {
    const facadePath = '@/features/llama-cpp-browser/hugging-face/download';
    const standalonePath = 'src/features/llama-cpp-browser/hugging-face/download-standalone.ts';
    const managerSource = readFileSync(
      resolve(process.cwd(), 'src/features/llama-cpp-browser/components/LlamaCppBrowserHuggingFaceManager.vue'),
      'utf8',
    );
    expect(managerSource).toContain(`from '${facadePath}'`);

    const aliases = createStandaloneFacadeAliases({ resolvePath: (path) => `/repo/${path}` });
    const alias = aliases.find(({ find }) => find instanceof RegExp && find.test(facadePath));
    expect(alias?.replacement).toBe(`/repo/${standalonePath}`);
    expect(alias?.find).toBeInstanceOf(RegExp);
    if (alias?.find instanceof RegExp) {
      expect(alias.find.test(`${facadePath}-estimate`)).toBe(false);
    }

    const standaloneSource = readFileSync(resolve(process.cwd(), standalonePath), 'utf8');
    expect(standaloneSource).not.toContain('new Worker');
    expect(standaloneSource).not.toContain('writer-entry');
    expect(standaloneSource).not.toMatch(/^import(?! type)[^;]*from ['"]\.\/download['"]/m);
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

it('routes the shared file downloader through the registered standalone worker, without engine-specific transfer clients', () => {
  const path = '@/logic/hugging-face-download/worker/factory';
  const definition = STANDALONE_FACADES.find(facade => facade.facadePath === path);
  expect(definition?.standalonePath).toBe('src/logic/hugging-face-download/worker/factory-standalone.ts');
  const client = readFileSync(resolve(process.cwd(), 'src/logic/hugging-face-download/client.ts'), 'utf8');
  expect(client).toContain(`from '${path}'`);
  const worker = readFileSync(resolve(process.cwd(), 'src/logic/hugging-face-download/worker/factory-standalone.ts'), 'utf8');
  expect(worker).toContain("from 'virtual:file-protocol-standalone/worker/file-download'");
  expect(worker).not.toContain('new Worker');
});
