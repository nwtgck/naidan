import { beforeAll, describe, expect, it } from 'vitest';
import { ESLint } from 'eslint';
import path from 'node:path';
import * as tsParser from '@typescript-eslint/parser';
import { rule } from './enforce-dependency-directions.js';

describe('enforce-dependency-directions rule', () => {
  let eslint: ESLint;
  const repoRoot = path.resolve(__dirname, '..');

  beforeAll(() => {
    eslint = new ESLint({
      cwd: repoRoot,
      overrideConfigFile: true,
      overrideConfig: {
        files: ['**/*.ts'],
        linterOptions: {
          reportUnusedDisableDirectives: 'error',
        },
        languageOptions: {
          parser: tsParser,
          parserOptions: {
            sourceType: 'module',
          },
        },
        plugins: {
          'local-rules': {
            rules: {
              'enforce-dependency-directions': rule,
            },
          },
        },
        rules: {
          'local-rules/enforce-dependency-directions': [
            'error',
            { rootDir: 'src', aliasPrefixes: ['@', '~'] },
          ],
        },
      },
    });
  });

  async function lintText({ code, filePath }: { code: string; filePath: string }) {
    const [result] = await eslint.lintText(code, {
      filePath: path.resolve(repoRoot, filePath),
    });
    return result;
  }

  async function expectAllowed({ code, filePath }: { code: string; filePath: string }) {
    const result = await lintText({ code, filePath });
    expect(result.messages).toHaveLength(0);
  }

  async function expectForbidden({ code, filePath }: { code: string; filePath: string }) {
    const result = await lintText({ code, filePath });
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.ruleId).toBe('local-rules/enforce-dependency-directions');
    expect(result.messages[0]?.messageId).toBe('forbiddenDependencyDirection');
  }

  it.each([
    'src/features/example/example.ts',
    'src/components/Example.ts',
    'src/composables/useExample.ts',
    'src/logic/example.ts',
    'src/pages/example.vue.ts',
  ])('allows application code to depend on 01-models from %s', async (filePath) => {
    await expectAllowed({ code: `import type { Chat } from '@/01-models/types';`, filePath });
  });

  it('allows application code to depend on storage service', async () => {
    await expectAllowed({
      code: `import { storageService } from '@/00-storage/service';`,
      filePath: 'src/features/example/example.ts',
    });
  });

  it('allows unrestricted dependencies between application directories', async () => {
    await expectAllowed({
      code: `import { useExample } from '@/composables/useExample';`,
      filePath: 'src/features/example/example.ts',
    });
  });

  it.each([
    '@/00-storage/00-dto/dto',
    '@/00-storage/mapper/mappers',
  ])('rejects application dependencies on storage internals: %s', async (importPath) => {
    await expectForbidden({
      code: `import type { Example } from '${importPath}';`,
      filePath: 'src/components/Example.ts',
    });
  });

  it.each([
    '@/features/example/example',
    '@/components/Example.vue',
    '@/composables/useExample',
    '@/logic/example',
    '@/pages/example.vue',
    '@/00-storage/service',
    '@/00-storage/mapper/mappers',
    '@/00-storage/00-dto/dto',
    '@/strings',
  ])('rejects 01-models dependencies on upper or persistence code: %s', async (importPath) => {
    await expectForbidden({
      code: `import type { Example } from '${importPath}';`,
      filePath: 'src/01-models/example.ts',
    });
  });

  it('allows 01-models dependencies on stable foundations', async () => {
    await expectAllowed({
      code: `import { VALUE } from '@/constants'; import { helper } from '@/utils/helper';`,
      filePath: 'src/01-models/example.ts',
    });
  });

  it('allows storage service dependencies on mapper and DTO', async () => {
    await expectAllowed({
      code: `import { map } from '@/00-storage/mapper/mappers'; import type { Dto } from '@/00-storage/00-dto/dto';`,
      filePath: 'src/00-storage/service/example.ts',
    });
  });

  it('rejects storage service dependencies on application code', async () => {
    await expectForbidden({
      code: `import { useExample } from '@/composables/useExample';`,
      filePath: 'src/00-storage/service/example.ts',
    });
  });

  it('allows mapper dependencies on DTO', async () => {
    await expectAllowed({
      code: `import type { Dto } from '@/00-storage/00-dto/dto';`,
      filePath: 'src/00-storage/mapper/example.ts',
    });
  });

  it('rejects mapper dependencies on storage service', async () => {
    await expectForbidden({
      code: `import { storageService } from '@/00-storage/service';`,
      filePath: 'src/00-storage/mapper/example.ts',
    });
  });

  it('rejects DTO dependencies on mapper', async () => {
    await expectForbidden({
      code: `import { map } from '@/00-storage/mapper/mappers';`,
      filePath: 'src/00-storage/00-dto/example.ts',
    });
  });

  it('rejects utils dependencies on 01-models', async () => {
    await expectForbidden({
      code: `import type { Chat } from '@/01-models/types';`,
      filePath: 'src/utils/example.ts',
    });
  });

  it('allows dependencies within the same Wesh command', async () => {
    await expectAllowed({
      code: `import { helper } from '@/features/wesh/commands/git/diff/helper';`,
      filePath: 'src/features/wesh/commands/git/index.ts',
    });
  });

  it('allows Wesh commands to depend on commands/_shared', async () => {
    await expectAllowed({
      code: `import { helper } from '@/features/wesh/commands/_shared/helper';`,
      filePath: 'src/features/wesh/commands/git/index.ts',
    });
  });

  it('allows Wesh command tests to import the root command registry', async () => {
    await expectAllowed({
      code: `import { commandDefinitions } from '@/features/wesh/commands/index';`,
      filePath: 'src/features/wesh/commands/git/git.help.test.ts',
    });
  });

  it('allows the root command registry to register specific commands', async () => {
    await expectAllowed({
      code: `import { gitCommandDefinition } from '@/features/wesh/commands/git';`,
      filePath: 'src/features/wesh/commands/index.ts',
    });
  });

  it('rejects production Wesh commands depending on the root command registry', async () => {
    const result = await lintText({
      code: `import { commandDefinitions } from '@/features/wesh/commands/index';`,
      filePath: 'src/features/wesh/commands/git/help.ts',
    });
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.messageId).toBe('forbiddenWeshCommandRegistryDependency');
  });

  it('rejects production Wesh commands depending on the root registry directory barrel', async () => {
    const result = await lintText({
      code: `import { commandDefinitions } from '@/features/wesh/commands';`,
      filePath: 'src/features/wesh/commands/git/help.ts',
    });
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.messageId).toBe('forbiddenWeshCommandRegistryDependency');
  });

  it('rejects commands/_shared depending on the root command registry', async () => {
    const result = await lintText({
      code: `import { commandDefinitions } from '@/features/wesh/commands/index';`,
      filePath: 'src/features/wesh/commands/_shared/registry-helper.ts',
    });
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.messageId).toBe('forbiddenWeshCommandRegistryDependency');
  });

  it('rejects direct dependencies between sibling Wesh commands', async () => {
    const result = await lintText({
      code: `import { helper } from '@/features/wesh/commands/diff/algorithm';`,
      filePath: 'src/features/wesh/commands/git/diff.ts',
    });
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.ruleId).toBe('local-rules/enforce-dependency-directions');
    expect(result.messages[0]?.messageId).toBe('forbiddenWeshCommandDependency');
  });

  it('rejects sibling Wesh command directory barrel imports', async () => {
    const result = await lintText({
      code: `import { diffCommand } from '@/features/wesh/commands/diff';`,
      filePath: 'src/features/wesh/commands/git/diff.ts',
    });
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.messageId).toBe('forbiddenWeshCommandDependency');
  });

  it('rejects relative dependencies between sibling Wesh commands', async () => {
    const result = await lintText({
      code: `import type { DiffInput } from '../diff/model';`,
      filePath: 'src/features/wesh/commands/git/diff.ts',
    });
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.messageId).toBe('forbiddenWeshCommandDependency');
  });

  it('rejects sibling Wesh command re-exports', async () => {
    const result = await lintText({
      code: `export { helper } from '@/features/wesh/commands/diff/algorithm';`,
      filePath: 'src/features/wesh/commands/git/index.ts',
    });
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.messageId).toBe('forbiddenWeshCommandDependency');
  });

  it('rejects sibling Wesh command dynamic imports', async () => {
    const result = await lintText({
      code: `const implementation = import('@/features/wesh/commands/patch/engine');`,
      filePath: 'src/features/wesh/commands/git/subcommands/apply.ts',
    });
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.messageId).toBe('forbiddenWeshCommandDependency');
  });

  it('rejects commands/_shared dependencies on a specific command', async () => {
    const result = await lintText({
      code: `import { helper } from '@/features/wesh/commands/git/diff/helper';`,
      filePath: 'src/features/wesh/commands/_shared/example.ts',
    });
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.messageId).toBe('forbiddenWeshCommandDependency');
  });

  it('checks relative imports', async () => {
    await expectForbidden({
      code: `import type { Dto } from '../00-storage/00-dto/dto';`,
      filePath: 'src/components/Example.ts',
    });
  });

  it('checks re-exports', async () => {
    await expectForbidden({
      code: `export type { Dto } from '@/00-storage/00-dto/dto';`,
      filePath: 'src/features/example/example.ts',
    });
  });

  it('checks dynamic imports', async () => {
    await expectForbidden({
      code: `const dto = import('@/00-storage/00-dto/dto');`,
      filePath: 'src/logic/example.ts',
    });
  });

  it('checks dynamic imports with static template literals', async () => {
    await expectForbidden({
      code: 'const dto = import(`@/00-storage/00-dto/dto`);',
      filePath: 'src/logic/example.ts',
    });
  });

  it('checks TypeScript import types', async () => {
    await expectForbidden({
      code: `type Dto = import('@/00-storage/00-dto/dto').Dto;`,
      filePath: 'src/pages/example.ts',
    });
  });

  it('checks vi.mock dependencies', async () => {
    await expectForbidden({
      code: `vi.mock('@/00-storage/mapper/mappers');`,
      filePath: 'src/components/Example.test.ts',
    });
  });

  it.each([
    `vi.importActual('@/00-storage/mapper/mappers')`,
    `vi.importMock('@/00-storage/mapper/mappers')`,
    `jest.requireActual('@/00-storage/mapper/mappers')`,
    `jest.requireMock('@/00-storage/mapper/mappers')`,
    `require('@/00-storage/mapper/mappers')`,
    `require.resolve('@/00-storage/mapper/mappers')`,
  ])('checks other static module-reference calls: %s', async (code) => {
    await expectForbidden({
      code: `${code};`,
      filePath: 'src/components/Example.test.ts',
    });
  });

  it('checks static template literals in test module-reference calls', async () => {
    await expectForbidden({
      code: 'vi.mock(`@/00-storage/mapper/mappers`);',
      filePath: 'src/components/Example.test.ts',
    });
  });

  it('checks import.meta.glob dependencies', async () => {
    await expectForbidden({
      code: `const modules = import.meta.glob('../../00-storage/00-dto/*.ts');`,
      filePath: 'src/features/example/example.ts',
    });
  });

  it('checks import.meta.glob dependency arrays', async () => {
    const result = await lintText({
      code: `const modules = import.meta.glob(['./local/*.ts', '../../00-storage/00-dto/*.ts']);`,
      filePath: 'src/features/example/example.ts',
    });
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.ruleId).toBe('local-rules/enforce-dependency-directions');
  });

  it('checks import.meta.glob dependencies with static template literals', async () => {
    await expectForbidden({
      code: 'const modules = import.meta.glob(`../../00-storage/00-dto/*.ts`);',
      filePath: 'src/features/example/example.ts',
    });
  });

  it('checks new URL dependencies', async () => {
    await expectForbidden({
      code: `const workerUrl = new URL('../../00-storage/00-dto/worker.ts', import.meta.url);`,
      filePath: 'src/features/example/example.ts',
    });
  });

  it('checks new URL dependencies with static template literals', async () => {
    await expectForbidden({
      code: 'const workerUrl = new URL(`../../00-storage/00-dto/worker.ts`, import.meta.url);',
      filePath: 'src/features/example/example.ts',
    });
  });

  it('ignores runtime URLs that are not resolved from import.meta.url', async () => {
    await expectAllowed({
      code: `const url = new URL('../00-storage/00-dto/worker.ts', runtimeBaseUrl);`,
      filePath: 'src/features/example/example.ts',
    });
  });

  it('allows one explicitly suppressed existing violation', async () => {
    await expectAllowed({
      code: `\
// eslint-disable-next-line local-rules/enforce-dependency-directions -- TODO(dependency-direction): Replace the DTO dependency with the storage service API.
import type { Dto } from '@/00-storage/00-dto/dto';`,
      filePath: 'src/features/example/example.ts',
    });
  });

  it('ignores package imports', async () => {
    await expectAllowed({
      code: `import { ref } from 'vue';`,
      filePath: 'src/01-models/example.ts',
    });
  });
  it('allows the Git entrypoint to import a subcommand', async () => {
    await expectAllowed({
      code: `import { runStatus } from './subcommands/status';`,
      filePath: 'src/features/wesh/commands/git/index.ts',
    });
  });

  it('allows a Git subcommand to import a Git domain module', async () => {
    await expectAllowed({
      code: `import { collectStatus } from '../status';`,
      filePath: 'src/features/wesh/commands/git/subcommands/status.ts',
    });
  });

  it('rejects a Git domain module importing a subcommand', async () => {
    const result = await lintText({
      code: `import { runStatus } from './subcommands/status';`,
      filePath: 'src/features/wesh/commands/git/status.ts',
    });
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.messageId).toBe('forbiddenWeshGitLayerDependency');
  });

  it('rejects one Git subcommand importing another', async () => {
    const result = await lintText({
      code: `import { runCommit } from './commit';`,
      filePath: 'src/features/wesh/commands/git/subcommands/status.ts',
    });
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.messageId).toBe('forbiddenWeshGitLayerDependency');
  });

  it('allows private modules within the same Git subcommand directory', async () => {
    await expectAllowed({
      code: `import { writeCombinedDiff } from './combined';`,
      filePath: 'src/features/wesh/commands/git/subcommands/diff/index.ts',
    });
  });

  it('rejects a nested Git subcommand helper importing another subcommand', async () => {
    const result = await lintText({
      code: `import { renderGraph } from '../log/graph';`,
      filePath: 'src/features/wesh/commands/git/subcommands/diff/combined.ts',
    });
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.messageId).toBe('forbiddenWeshGitLayerDependency');
  });

});
