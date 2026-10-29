import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint, Linter, type Rule } from 'eslint';
import type ts from 'typescript';
import * as tsParser from '@typescript-eslint/parser';
import vueParser from 'vue-eslint-parser';
import { describe, expect, it } from 'vitest';
import { rule } from './validate-worker-api.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, '..');
const fixtureRoot = path.join(here, 'fixtures/worker-transport');
const fixtureProject = path.join(fixtureRoot, 'tsconfig.json');

function createEslint({ genericBridgeFileSuffixes = [], analysisBudget, workerApiRule = rule }: {
  genericBridgeFileSuffixes?: string[],
  analysisBudget?: number,
  workerApiRule?: Rule.RuleModule,
} = {}) {
  return new ESLint({
    cwd: projectRoot,
    overrideConfigFile: true,
    overrideConfig: [{
      files: ['**/*.ts', '**/*.tsx'],
      languageOptions: {
        parser: tsParser,
        parserOptions: {
          project: fixtureProject,
          tsconfigRootDir: projectRoot,
          // Both parser instances share this project. Include Vue from the
          // first program creation, not only after a TS/TSX fixture cached it.
          extraFileExtensions: ['.vue'],
        },
      },
      plugins: {
        local: {
          rules: {
            'validate-worker-api': workerApiRule,
          },
        },
      },
      rules: {
        'local/validate-worker-api': ['error', { genericBridgeFileSuffixes, analysisBudget }],
      },
    }],
  });
}

function createVueEslint() {
  return new ESLint({
    cwd: projectRoot,
    overrideConfigFile: true,
    overrideConfig: [{
      files: ['**/*.vue'],
      languageOptions: {
        parser: vueParser,
        parserOptions: {
          parser: tsParser,
          extraFileExtensions: ['.vue'],
          project: fixtureProject,
          tsconfigRootDir: projectRoot,
        },
      },
      plugins: {
        local: { rules: { 'validate-worker-api': rule } },
      },
      rules: {
        'local/validate-worker-api': 'error',
      },
    }],
  });
}

describe('validate-worker-api rule', () => {
  it('allows transferred native readable streams with validated chunk types', async () => {
    const [result] = await createEslint().lintFiles([path.join(fixtureRoot, 'worker-api-stream-probe.ts')]);
    const messages = result.messages.map(message => message.message);
    expect(messages).toEqual([
      expect.stringContaining('transfer-required:ReadableStream'),
      expect.stringContaining('capability-sensitive:ReadableStream'),
      expect.stringContaining('transfer-required:ReadableStream'),
      expect.stringContaining('capability-sensitive:ReadableStream'),
      expect.stringContaining('unknown'),
      expect.stringContaining('function-must-be-proxied'),
      expect.stringContaining('external-unreviewed:Uint8Array<SharedArrayBuffer>'),
      expect.stringContaining('capability-sensitive:ReadableStream'),
      expect.stringContaining('transfer-required:ReadableStream'),
      expect.stringContaining('function-must-be-proxied'),
    ]);
  }, 20_000);

  it('accepts native ArrayBuffer-backed views with explicit TypeScript buffer arguments', async () => {
    const [result] = await createEslint().lintFiles([path.join(fixtureRoot, 'worker-api-arraybuffer-view-probe.ts')]);
    expect(result.messages).toEqual([]);
  }, 20_000);

  it('does not extend native view approval to shared or unspecified buffers', async () => {
    const [result] = await createEslint().lintFiles([path.join(fixtureRoot, 'worker-api-shared-view-probe.ts')]);
    expect(result.messages.map(message => message.message)).toEqual([
      expect.stringContaining('external-unreviewed:Uint8Array<SharedArrayBuffer>'),
      expect.stringContaining('external-unreviewed:Uint8Array<ArrayBufferLike>'),
    ]);
  }, 20_000);

  it('does not approve a local callable object with the same generic name as a native view', async () => {
    const [result] = await createEslint().lintFiles([path.join(fixtureRoot, 'worker-api-impostor-view-probe.ts')]);
    expect(result.messages.map(message => message.message)).toEqual([
      expect.stringContaining('function-must-be-proxied'),
    ]);
    expect(result.messages[0]!.message).toContain('callback');
  }, 20_000);

  it('classifies unsafe worker API shapes without expanding reviewed-safe structural types', async () => {
    const [result] = await createEslint().lintFiles([
      path.join(fixtureRoot, 'worker-api-semantic-probe.ts'),
    ]);
    const messages = result.messages.map(message => message.message);

    expect(messages).toHaveLength(18);
    expect(messages.some(message => message.includes('payload[string]') && message.endsWith('unknown.'))).toBe(true);
    expect(messages.some(message => message.includes('callback') && message.includes('function-must-be-proxied'))).toBe(true);
    expect(messages.some(message => message.includes('handle') && message.includes('capability-sensitive'))).toBe(true);
    expect(messages.some(message => message.includes('capability-marker-must-be-top-level'))).toBe(true);
    expect(messages.some(message => message.includes('proxy-must-be-top-level'))).toBe(true);
    expect(messages.some(message => message.includes('external-unreviewed'))).toBe(true);
    expect(messages.some(message => message.includes('transfer-required:MessagePort'))).toBe(true);
    expect(messages.some(message => message.includes('transfer-must-be-top-level'))).toBe(true);
    expect(messages.some(message => message.includes('type-parameter-unreviewed:T'))).toBe(true);
    expect(messages.some(message => message.includes('.proxy.arg0.nested.callback'))).toBe(true);
    expect(messages.some(message => message.includes('.proxy.read.return.nested.callback'))).toBe(true);
    expect(messages.filter(message => message.includes('nested.callback') && message.includes('function-must-be-proxied'))).toHaveLength(6);
  }, 20_000);


  it('validates Worker API contracts from TSX and Vue scripts', async () => {
    const [tsxResult] = await createEslint().lintFiles([path.join(fixtureRoot, 'worker-api-tsx-probe.tsx')]);
    const [vueResult] = await createVueEslint().lintFiles([path.join(fixtureRoot, 'worker-api-vue-probe.vue')]);

    for (const result of [tsxResult, vueResult]) {
      expect(result.messages.map(message => message.message)).toEqual([
        expect.stringContaining('function-must-be-proxied'),
      ]);
    }
  }, 20_000);

  it('fails closed when semantic analysis exceeds its configured budget', async () => {
    const [result] = await createEslint({ analysisBudget: 1 }).lintFiles([
      path.join(fixtureRoot, 'analysis-budget-probe.ts'),
    ]);
    const messages = result.messages.map(message => message.message);

    expect(messages).toEqual([expect.stringContaining('analysis-budget-exceeded')]);
  }, 20_000);

  it('validates exposed named worker contracts and rejects anonymous exposed contracts', async () => {
    const [result] = await createEslint().lintFiles([
      path.join(fixtureRoot, 'worker-api-expose-probe.ts'),
    ]);
    const messages = result.messages.map(message => message.message);

    expect(messages).toHaveLength(3);
    expect(messages.some(message => message.includes('callback') && message.includes('function-must-be-proxied'))).toBe(true);
    expect(messages.some(message => message.includes('metadata[string]') && message.endsWith('unknown.'))).toBe(true);
    expect(messages.some(message => message.includes('named-worker-api-contract-required'))).toBe(true);
  }, 20_000);

  it('allows only explicitly listed generic forwarding bridges', async () => {
    const allowed = path.join(fixtureRoot, 'allowed-generic-worker-bridge.ts');
    const disallowed = path.join(fixtureRoot, 'disallowed-generic-worker-bridge.ts');
    const eslint = createEslint({
      genericBridgeFileSuffixes: ['/eslint-local-rules/fixtures/worker-transport/allowed-generic-worker-bridge.ts'],
    });
    const results = await eslint.lintFiles([allowed, disallowed]);
    const byFile = new Map(results.map(result => [path.basename(result.filePath), result.messages.map(message => message.message)]));

    expect(byFile.get('allowed-generic-worker-bridge.ts')).toEqual([]);
    expect(byFile.get('disallowed-generic-worker-bridge.ts')).toEqual([
      expect.stringContaining('generic-transport-bridge-not-allowed'),
    ]);
  }, 20_000);
  it('does not resolve signatures when neither a contract nor an exposed value exists', () => {
    let resolutions = 0;
    const parser = {
      parseForESLint(source: string) {
        const parsed = tsParser.parseForESLint(source, { range: true, loc: true, tokens: true, comment: true });
        return {
          ...parsed,
          services: {
            ...parsed.services,
            program: {
              getTypeChecker: () => ({
                getResolvedSignature() {
                  resolutions += 1;
                  return undefined;
                },
              }),
            },
          },
        };
      },
    };
    const messages = new Linter({ cwd: projectRoot }).verify(`
ordinary();
wrapWorkerRemote();
exposeWorkerRemote();
Comlink.wrap();
Comlink.expose();
alias?.();
`, [{
      languageOptions: { parser },
      plugins: { local: { rules: { api: rule } } },
      rules: { 'local/api': 'error' },
    }], { filename: 'src/query-probe.js' });
    expect(messages).toEqual([]);
    expect(resolutions).toBe(0);
  });

  it('skips overload resolution only for unrelated function declarations, not aliases or unknown callable shapes', async () => {
    const resolutions: string[] = [];
    const instrumentedRule: Rule.RuleModule = {
      ...rule,
      create(context) {
        const services = context.sourceCode.parserServices!;
        const checker = services.program.getTypeChecker();
        const measuredChecker = Object.create(checker, {
          getResolvedSignature: {
            value(node: ts.CallLikeExpression) {
              resolutions.push(node.getText());
              return checker.getResolvedSignature(node);
            },
          },
        });
        const program = Object.create(services.program, { getTypeChecker: { value: () => measuredChecker } });
        const sourceCode = Object.create(context.sourceCode, { parserServices: { value: { ...services, program } } });
        return rule.create(Object.create(context, { sourceCode: { value: sourceCode } }));
      },
    };
    const [result] = await createEslint({ workerApiRule: instrumentedRule }).lintFiles([
      path.join(fixtureRoot, 'worker-api-selection-alias-probe.ts'),
    ]);
    expect(result.fatalErrorCount).toBe(0);
    for (const call of ['ordinary<UnsafeApi>(worker)', 'overloaded<UnsafeApi>(worker)', 'ordinaryAlias<UnsafeApi>(worker)']) {
      expect(resolutions).not.toContain(call);
    }
    for (const call of [
      'importedWrap<UnsafeApi>(worker)', 'bridges.wrapWorkerRemote<UnsafeApi>(worker)',
      'alias<UnsafeApi>(worker)', "object['wrap']<UnsafeApi>(worker)", 'obtainWrap()<UnsafeApi>(worker)',
      'nullable?.<UnsafeApi>(worker)', 'intersection<UnsafeApi>(worker)', 'union<UnsafeApi>(worker)',
      'methods.wrapWorkerRemote<UnsafeApi>(worker)', 'callable<UnsafeApi>(worker)', 'importedExpose(api)',
    ]) {
      expect(resolutions).toContain(call);
    }
    // Pin unsafe diagnostics, including the original direct-name/Comlink
    // fallback for calls whose declared function has an unrelated name.
    expect(result.messages.map(message => [message.line, message.messageId])).toEqual([
      [24, 'invalidApi'], [25, 'invalidApi'], [26, 'invalidApi'], [27, 'invalidApi'],
      [28, 'invalidApi'], [29, 'invalidApi'], [30, 'invalidApi'], [31, 'invalidApi'],
      [32, 'invalidApi'], [33, 'invalidApi'], [34, 'invalidApi'], [35, 'invalidApi'],
      [36, 'invalidApi'], [38, 'invalidApi'], [39, 'invalidApi'], [45, 'invalidApi'],
      [46, 'invalidApi'], [47, 'invalidApi'], [48, 'invalidApi'], [57, 'invalidApi'],
      [58, 'invalidApi'],
    ]);
  }, 20_000);

  it('still resolves aliases and validates explicit contracts even without runtime arguments', async () => {
    const [result] = await createEslint().lintFiles([path.join(fixtureRoot, 'worker-api-call-selection-probe.ts')]);
    expect(result.fatalErrorCount).toBe(0);
    expect(result.messages.map(message => [message.line, message.messageId])).toEqual([
      [11, 'invalidApi'], [12, 'invalidApi'], [13, 'invalidApi'],
      [14, 'invalidApi'], [15, 'invalidApi'], [16, 'invalidApi'],
    ]);
    expect(result.messages.every(message => message.message.includes('function-must-be-proxied'))).toBe(true);
  });
});
