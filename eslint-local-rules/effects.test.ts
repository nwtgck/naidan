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
    const fixture = createFixture({ files: { 'main.ts': "import { save } from './storage';\n/** @effects [] */ export function run() { save(); }", 'storage.ts': '/** @effects [] */ export function save() { localStorage.clear(); }' }, entries: ['main.ts'] });
    try {
      const linter = createLinter({ root: fixture.root, config: fixture.config, typed: true });
      const [result] = await linter.lintFiles(['main.ts']);
      expect(result?.errorCount).toBe(2);
      expect(result?.messages.some(message => message.message.includes('storage.ts'))).toBe(true);
      expect(result?.messages.every(message => message.fix === undefined)).toBe(true);
    } finally { fixture.dispose(); }
  });
  it('reports each selected source diagnostic at its own location without duplicating other selected files', async () => {
    const fixture = createFixture({ files: {
      'main.ts': '/** @effects [] */ export function run() { localStorage.clear(); }',
      'other.ts': '/** @effects [] */ export function save() { sessionStorage.clear(); }',
    }, entries: ['main.ts', 'other.ts'] });
    try {
      const results = await createLinter({ root: fixture.root, config: fixture.config, typed: true }).lintFiles(['main.ts', 'other.ts']);
      expect(results.map(result => result.errorCount)).toEqual([1, 1]);
      expect(results[0]?.messages[0]?.message).toContain('localstorage.write(*)');
      expect(results[1]?.messages[0]?.message).toContain('sessionstorage.write(*)');
      expect(results.every(result => result.messages[0]?.column === 20)).toBe(true);
    } finally { fixture.dispose(); }
  });

  it('keeps dependency-only failures visible across repeated lint calls', async () => {
    const fixture = createFixture({ files: {
      'main.ts': "import './storage';\n/** @effects [] */ export function run() {}",
      'storage.ts': '/** @effects [] */ export function save() { localStorage.clear(); }',
    }, entries: ['main.ts'] });
    try {
      const linter = createLinter({ root: fixture.root, config: fixture.config, typed: true });
      for (let invocation = 0; invocation < 2; invocation++) {
        const [result] = await linter.lintFiles(['main.ts']);
        expect(result?.errorCount).toBe(1);
        expect(result?.messages[0]?.message).toContain('outside the configured entries');
        expect(result?.messages[0]?.message).toContain('storage.ts');
      }
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
    const fixture = createFixture({ files: { 'main.ts': '/** @effects [] */ function inspect() {}', 'unrelated.ts': 'function notRolledOut() { localStorage.clear(); }' }, entries: ['main.ts', 'unrelated.ts'] });
    fixture.config.files = ['main.ts'];
    try {
      const results = await createLinter({ root: fixture.root, config: fixture.config, typed: true }).lintFiles(['main.ts', 'unrelated.ts']);
      expect(results.flatMap(result => result.messages)).toEqual([]);
    } finally { fixture.dispose(); }
  });
  it('fails a changed reviewed model without accepting a cached analysis', async () => {
    const declaration = 'export declare function foreign(): void;';
    const fixture = createFixture({ files: { 'main.ts': "import { foreign } from './model';\n/** @effects [] */ function run() { foreign(); }", 'model.d.ts': declaration }, entries: ['main.ts'] });
    fixture.config.models = [{ file: 'model.d.ts', export: 'foreign', effects: [], returnValue: 'scalar', sha256: digest({ content: declaration }) }];
    try {
      const linter = createLinter({ root: fixture.root, config: fixture.config, typed: true });
      const initialMessages = (await linter.lintFiles(['main.ts']))[0]?.messages;
      expect(initialMessages).toHaveLength(1);
      expect(initialMessages?.[0]?.message).toContain('Runtime import initialization has no checked module body');
      fs.appendFileSync(path.join(fixture.root, 'model.d.ts'), '\n// changed');
      expect((await linter.lintFiles(['main.ts']))[0]?.messages[0]?.message).toContain('Reviewed effect model changed');
    } finally { fixture.dispose(); }
  });
});

describe('explicit exception integration with typed ESLint', () => {
  it('respects the exception without giving the rule a blanket ignore', async () => {
    const source = `\
/** @effects [] */
/** @effectsUNSAFE {"effects":["localstorage.write(*)"],"reason":"Reviewed fixture."} */
function probe() { localStorage.clear(); }
/** @effects [] */ function caller() { probe(); }
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
/** @effects [] */
/** @effectsUNSAFE {"effects":["localstorage.write(*)"],"reason":"Reviewed fixture."} */
function probe() { localStorage.clear(); fetch('/unexpected'); }
/** @effects [] */ function caller() { probe(); }
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
