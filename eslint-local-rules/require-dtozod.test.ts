import { describe, expect, it } from 'vitest';
import { ESLint } from 'eslint';
import * as parser from '@typescript-eslint/parser';
import path from 'node:path';
import { rule } from './require-dtozod.js';

const eslint = new ESLint({
  overrideConfigFile: true,
  overrideConfig: {
    files: ['**/*.ts'],
    languageOptions: { parser, parserOptions: { sourceType: 'module', ecmaVersion: 'latest' } },
    plugins: { dto: { rules: { boundary: rule } } },
    rules: { 'dto/boundary': 'error' },
  },
});

async function lint({ code, filePath }: { code: string, filePath: string }) {
  const [result] = await eslint.lintText(code, { filePath: path.resolve(filePath) });
  if (!result) throw new Error('Missing lint result');
  return result.messages;
}

describe('DTO dialect boundary', () => {
  it.each([
    "import { z } from 'zod';",
    "import * as renamed from 'zod/v4';",
    "import 'zod';",
    "export { z as dtozod } from 'zod';",
    "export * from 'zod/v4/core';",
    "export * as bypass from 'zod';",
    "const raw = await import('zod');",
    "const raw = await import(`zod`);",
    "const raw = require('zod');",
    "import raw = require('zod');",
    "import { missingAsUndefined } from '@/utils/zod/missingAsUndefined';",
  ])('rejects an unrestricted runtime source: %s', async code => {
    const messages = await lint({ code, filePath: 'src/00-storage/00-dto/example.dto.ts' });
    expect(messages.map(message => message.messageId)).toEqual(['native']);
  });

  it.each([
    "import type { z } from 'zod'; type T = z.infer<typeof schema>;",
    "import { type z } from 'zod';",
    "export type { ZodType } from 'zod';",
    "export { type ZodType } from 'zod';",
    "export type * from 'zod';",
    "type T = import('zod').ZodType;",
    "import * as dtozod from '@/utils/dtozod'; const shape = dtozod.object({ name: dtozod.string() });",
    "import { missingAsUndefined } from '@/utils/dtozod/missingAsUndefined';",
    "const roles = ['user', 'assistant'] as const;",
    "type Output = typeof schema['_zod']['output'];",
  ])('allows structural declarations and type-only interoperability: %s', async code => {
    expect(await lint({ code, filePath: 'src/features/wesh/dto.ts' })).toEqual([]);
  });

  it.each([
    'const escaped = schema as unknown;',
    'const escaped = <NativeSchema>schema;',
    'const fake = raw as DtoSchema;',
  ])('rejects assertions inside DTO definitions: %s', async code => {
    const messages = await lint({ code, filePath: 'src/00-storage/00-dto/dto.ts' });
    expect(messages.map(message => message.messageId)).toEqual(['assertion']);
  });

  it.each([
    'schema._zod;',
    "schema['_zod'];",
    'const { _zod: native } = schema;',
    "const { ['_zod']: native } = schema;",
  ])('rejects runtime inference-slot access: %s', async code => {
    const messages = await lint({ code, filePath: 'src/00-storage/00-dto/example.dto.ts' });
    expect(messages.map(message => message.messageId)).toEqual(['internals']);
  });

  it.each([
    'src/00-storage/00-dto/compatibility/experimental-field.ts',
    'src/utils/dtozod/index.ts',
    'src/00-storage/00-dto/example.dto.test.ts',
    'src/features/naidan-rpc-integration/contract.ts',
  ])('does not police non-DTO implementations: %s', async filePath => {
    expect(await lint({ code: "import { z } from 'zod'; z.string().min(1);", filePath })).toEqual([]);
  });
});

describe('DTO native-schema export provenance', () => {
  const fixtureRoot = path.resolve(import.meta.dirname, 'fixtures/dtozod');
  const typedEslint = new ESLint({
    overrideConfigFile: true,
    overrideConfig: {
      files: ['**/*.ts'],
      languageOptions: { parser, parserOptions: { project: path.join(fixtureRoot, 'tsconfig.json'), tsconfigRootDir: path.resolve(import.meta.dirname, '..') } },
      plugins: { dto: { rules: { boundary: rule } } },
      rules: { 'dto/boundary': 'error' },
    },
  });

  it('rejects imported native aliases, returned schemas and schema containers without direct Zod imports', async () => {
    const [result] = await typedEslint.lintFiles([path.join(fixtureRoot, 'native.dto.ts')]);
    expect(result!.messages.map(message => message.messageId)).toEqual(Array(9).fill('nativeExport'));
  });

  it('rejects star and namespace barrels of unrestricted schemas', async () => {
    const [result] = await typedEslint.lintFiles([path.join(fixtureRoot, 'barrel.dto.ts')]);
    expect(result!.messages.map(message => message.messageId)).toEqual(['nativeExport', 'nativeExport']);
  });

  it.each(['structural.dto.ts', 'type-only.dto.ts'])('allows structural declarations and type-only exports in %s', async file => {
    const [result] = await typedEslint.lintFiles([path.join(fixtureRoot, file)]);
    expect(result!.messages).toEqual([]);
  });
});
