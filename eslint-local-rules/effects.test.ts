import fs from 'node:fs';
import path from 'node:path';
import { ESLint } from 'eslint';
import * as parser from '@typescript-eslint/parser';
import { describe, expect, it } from 'vitest';
import { createEffectsRule } from './effects.ts';
import { createFixture } from '../tools/effects/test-support/project-fixture.ts';
import type { EffectsConfig } from '../tools/effects/config.ts';
import { digest } from '../tools/effects/project.ts';

function createLinter({ root, config, typed }: { root: string, config: EffectsConfig, typed: boolean }) {
  return new ESLint({ cwd: root, overrideConfigFile: true, overrideConfig: [{
    files: ['**/*.ts'],
    languageOptions: { parser, parserOptions: typed ? { project: path.join(root, config.tsconfig), tsconfigRootDir: root } : {} },
    plugins: { effects: { rules: { contracts: createEffectsRule({ root, config }) } } },
    rules: { 'effects/contracts': 'error' },
  }] });
}

describe('TypeScript effects ESLint integration', () => {
  it('uses the same transitive contract diagnostics as the command', async () => {
    const fixture = createFixture({ files: { 'main.ts': "import { save } from './storage';\n/** @effects `none` */ export function run() { save(); }", 'storage.ts': '/** @effects `none` */ export function save() { localStorage.clear(); }' }, entries: ['main.ts'] });
    try {
      const linter = createLinter({ root: fixture.root, config: fixture.config, typed: true });
      const [result] = await linter.lintFiles(['main.ts']);
      expect(result?.errorCount).toBe(2);
      expect(result?.messages.some(message => message.message.includes('storage.ts'))).toBe(true);
      expect(result?.messages.every(message => message.fix === undefined)).toBe(true);
    } finally { fixture.dispose(); }
  });
  it('does not analyze or require annotations in a selected ordinary test file', async () => {
    const fixture = createFixture({ files: { 'example.test.ts': 'function testBody() { localStorage.clear(); }' }, entries: ['example.test.ts'] });
    try {
      const [result] = await createLinter({ root: fixture.root, config: fixture.config, typed: false }).lintFiles(['example.test.ts']);
      expect(result?.messages).toEqual([]);
    } finally { fixture.dispose(); }
  });
  it('reports missing type services rather than passing a scoped source silently', async () => {
    const fixture = createFixture({ files: { 'main.ts': 'function save() { localStorage.clear(); }' }, entries: ['main.ts'] });
    try {
      const [result] = await createLinter({ root: fixture.root, config: fixture.config, typed: false }).lintFiles(['main.ts']);
      expect(result?.messages[0]?.message).toContain('requires a typescript-eslint Program');
    } finally { fixture.dispose(); }
  });
  it('does not treat unrelated files in the typed lint Program as effect entries', async () => {
    const fixture = createFixture({ files: { 'main.ts': '/** @effects `none` */ function inspect() {}', 'unrelated.ts': 'function notRolledOut() { localStorage.clear(); }' }, entries: ['main.ts', 'unrelated.ts'] });
    fixture.config.files = ['main.ts'];
    try {
      const results = await createLinter({ root: fixture.root, config: fixture.config, typed: true }).lintFiles(['main.ts', 'unrelated.ts']);
      expect(results.flatMap(result => result.messages)).toEqual([]);
    } finally { fixture.dispose(); }
  });
  it('fails a changed reviewed model without accepting a cached analysis', async () => {
    const declaration = 'export declare function foreign(): void;';
    const fixture = createFixture({ files: { 'main.ts': "import { foreign } from './model';\n/** @effects `none` */ function run() { foreign(); }", 'model.d.ts': declaration }, entries: ['main.ts'] });
    fixture.config.models = [{ file: 'model.d.ts', export: 'foreign', effects: [], returnValue: 'scalar', sha256: digest({ content: declaration }) }];
    try {
      const linter = createLinter({ root: fixture.root, config: fixture.config, typed: true });
      expect((await linter.lintFiles(['main.ts']))[0]?.messages).toEqual([]);
      fs.appendFileSync(path.join(fixture.root, 'model.d.ts'), '\n// changed');
      expect((await linter.lintFiles(['main.ts']))[0]?.messages[0]?.message).toContain('Reviewed effect model changed');
    } finally { fixture.dispose(); }
  });
});

describe('explicit exception integration with typed ESLint', () => {
  it('respects the exception without giving the rule a blanket ignore', async () => {
    const source = `\
/** @effects \`none\` */
/** @effectsUNSAFE \`localstorage.write(*)\` -- "Reviewed fixture." */
function probe() { localStorage.clear(); }
/** @effects \`none\` */ function caller() { probe(); }
`;
    const fixture = createFixture({ files: { 'main.ts': source }, entries: ['main.ts'] });
    try {
      const [result] = await createLinter({ root: fixture.root, config: fixture.config, typed: true }).lintFiles(['main.ts']);
      expect(result?.messages).toEqual([]);
      expect(fixture.check().unsafeSuppressions).toHaveLength(1);
    } finally { fixture.dispose(); }
  });
  it('still reports an added operation in both the function and its caller', async () => {
    const source = `\
/** @effects \`none\` */
/** @effectsUNSAFE \`localstorage.write(*)\` -- "Reviewed fixture." */
function probe() { localStorage.clear(); fetch('/unexpected'); }
/** @effects \`none\` */ function caller() { probe(); }
`;
    const fixture = createFixture({ files: { 'main.ts': source }, entries: ['main.ts'] });
    try {
      const [result] = await createLinter({ root: fixture.root, config: fixture.config, typed: true }).lintFiles(['main.ts']);
      expect(result?.errorCount).toBe(2);
      expect(result?.messages.every(message => message.message.includes('network.http(*)'))).toBe(true);
      expect(result?.messages.every(message => message.fix === undefined)).toBe(true);
    } finally { fixture.dispose(); }
  });
});
