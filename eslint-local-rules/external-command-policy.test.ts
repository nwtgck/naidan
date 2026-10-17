// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { Linter } from 'eslint';
import * as tsParser from '@typescript-eslint/parser';
import vueParser from 'vue-eslint-parser';
import path from 'node:path';
import policy from './external-command-policy.js';

const repoRoot = path.resolve(import.meta.dirname, '..');
const permission = '// !!! ALLOW-EXTERNAL-COMMAND git diff:* !!! -- Verify generated output.';
const runnerImport = "import { runCommand, runCommandSync } from '../build/command';";
const call = "runCommand({ argv: ['git', 'diff', ...paths], options: { cwd: fixture } })";

function lint({ code, filename }: { code: string, filename: string }) {
  const messages = new Linter({ cwd: repoRoot }).verify(code, [{
    ...policy,
    languageOptions: {
      parser: filename.endsWith('.vue') ? vueParser : tsParser,
      sourceType: 'module',
      parserOptions: { parser: tsParser, project: false },
    },
  }], { filename: path.resolve(repoRoot, filename) });
  expect(messages.filter(message => message.fatal)).toEqual([]);
  expect(messages.every(message => message.fix === undefined && message.suggestions === undefined)).toBe(true);
  return messages.map(message => message.messageId);
}

function ids({ code, filename = 'src/example.test.ts' }: { code: string, filename?: string }) {
  return lint({ code, filename });
}

function permitted({ body }: { body: string }) {
  return `${permission}\n${runnerImport}\n${body};`;
}

describe('common command runner permission', () => {
  it.each(['src/example.test.ts', 'src/fixture.test-support.ts', 'build/example.ts', 'scripts/example.ts', 'src/runtime.ts', 'pwa/example.ts'])('allows permissions at the actual call file %s', filename => {
    expect(ids({ code: permitted({ body: call }), filename })).toEqual([]);
  });

  it('allows renamed imports, expression type wrappers, and runtime suffix arguments', () => {
    const code = permitted({ body: call.replace('runCommand(', 'execute(').replace("['git', 'diff', ...paths]", "['git', 'diff', dynamicArg, ...paths] as const") })
      .replace('import { runCommand, runCommandSync }', 'import { runCommand as execute, runCommandSync }');
    expect(ids({ code })).toEqual([]);
  });

  it('permits arbitrary executables and command-level permission without a registry', () => {
    for (const [prefix, argv] of [['git', "['git', command, ...args]"], ['node --version', "['node', '--version']"], ['custom-tool frobnicate', "['custom-tool', 'frobnicate', ...args]"]]) {
      const code = permitted({ body: `runCommandSync({ argv: ${argv}, options: undefined })` }).replace('git diff:*', `${prefix}:*`);
      expect(ids({ code })).toEqual([]);
    }
  });

  it('allows exports of ordinary functions that contain a declared direct call', () => {
    const code = permitted({ body: `export function readDiff() { return ${call}; }` });
    expect(ids({ code })).toEqual([]);
  });

  it('allows multiple calls per permission and only type references to the runner', () => {
    expect(ids({ code: permitted({ body: `${call}; ${call}; type Runner = typeof runCommand` }) })).toEqual([]);
  });

  it('requires the general external-command marker in tests and ordinary source files', () => {
    const code = permitted({ body: call }).replace('ALLOW-EXTERNAL-COMMAND', 'ALLOW-TEST-COMMAND');
    for (const filename of ['src/example.test.ts', 'scripts/example.ts', 'build/example.ts']) {
      expect(ids({ code, filename })).toContain('missingPermission');
    }
  });

  it('requires a broad permission to be independently used when a narrower one matches', () => {
    const broad = '// !!! ALLOW-EXTERNAL-COMMAND git:* !!! -- Permit fixture commands.';
    const code = `${broad}\n${permitted({ body: call })}`;
    expect(ids({ code })).toEqual(['unusedPermission']);
    const other = "runCommandSync({ argv: ['git', 'status'], options: undefined });";
    expect(ids({ code: `${code}\n${other}` })).toEqual([]);
  });

  it('matches common runner module references without relying on a basename', () => {
    for (const target of ['../build/command.ts', '../build/command.js?source', '@/../build/command', path.join(repoRoot, 'build/command.ts')]) {
      expect(ids({ code: permitted({ body: call }).replace('../build/command', target) })).toEqual([]);
    }
    expect(ids({ code: "import { runCommand } from './command'; runCommand(input);" })).toEqual([]);
  });

  it.each([
    ['missingPermission', `${runnerImport}\n${call};`],
    ['mismatchedPermission', permitted({ body: call.replace("'diff'", "'difftool'") })],
    ['mismatchedPermission', permitted({ body: call.replace("'git', 'diff'", "'git diff'") })],
    ['mismatchedPermission', permitted({ body: call.replace("'diff'", 'command') })],
    ['mismatchedPermission', permitted({ body: call.replace("'diff'", '...commands') })],
    ['mismatchedPermission', permitted({ body: call.replace("'diff'", '`diff`') })],
    ['mismatchedPermission', permitted({ body: call.replace("'diff'", "'di' + 'ff'") })],
    ['invalidRunnerCall', permitted({ body: call.replace("'git'", 'executable') })],
    ['invalidRunnerCall', permitted({ body: call.replace("['git', 'diff', ...paths]", 'argv') })],
    ['invalidRunnerCall', permitted({ body: call.replace("['git', 'diff', ...paths]", '[]') })],
    ['invalidRunnerCall', permitted({ body: call.replace('argv:', "['argv']:") })],
    ['invalidRunnerCall', permitted({ body: call.replace('options:', '...other, options:') })],
    ['invalidRunnerCall', permitted({ body: call.replace('options:', 'argv: [], options:') })],
    ['invalidRunnerCall', permitted({ body: call.replace('options:', 'shell: true, options:') })],
    ['invalidRunnerCall', permitted({ body: "runCommand({ get argv() { return ['git', 'diff']; }, options: undefined })" })],
    ['invalidRunnerCall', permitted({ body: "runCommand({ argv() {}, options: undefined })" })],
    ['invalidRunnerCall', permitted({ body: "runCommand({ argv: ['git', 'diff'] })" })],
    ['invalidRunnerCall', permitted({ body: 'runCommand(input)' })],
    ['invalidRunnerCall', permitted({ body: 'runCommand({ ...input })' })],
    ['malformedPermission', permitted({ body: call }).replace('-- Verify generated output.', '-- ')],
    ['malformedPermission', permitted({ body: call }).replace('git diff:*', 'git *:*')],
    ['malformedPermission', permitted({ body: call }).replace('git diff:*', 'git  diff:*')],
    ['duplicatePermission', permitted({ body: call }).replace(permission, `${permission}\n${permission}`)],
    ['misplacedPermission', `${runnerImport}\n${permission}\n${call};`],
    ['unusedPermission', `${permission}\nexport {};`],
  ])('reports %s for an unreviewable or unpermitted call', (expected, code) => {
    expect(ids({ code })).toContain(expected);
  });

  it.each([
    'const execute = runCommand;',
    'export { runCommand };',
    'export default runCommand;',
    'consume(runCommand);',
    'const holder = { runCommand };',
    'const holder = [runCommand];',
    'function escape() { return runCommand; }',
    'runCommand.call(undefined, options);',
    'runCommand.apply(undefined, options);',
    'runCommand.bind(undefined);',
    call.replace('runCommand(', 'runCommand?.('),
  ])('rejects runner binding escape: %s', body => {
    expect(ids({ code: permitted({ body }) })).toContain('runnerEscape');
  });

  it.each([
    "export { runCommand } from '../build/command';",
    "export * from '../build/command';",
    "import * as command from '../build/command';",
    "import command from '../build/command';",
    "const command = require('../build/command');",
    "import('../build/command.js?raw');",
    "vi.importActual('../build/command');",
    "vi.mock('../build/command', async original => { const actual = await original(); return actual; });",
  ])('rejects indirect acquisition of the common runner: %s', code => {
    expect(ids({ code })).toContain('runnerEscape');
  });

  it.each([
    "import type { CommandOptions } from '../build/command';",
    "export type { CommandOptions } from '../build/command';",
    "type Runner = typeof import('../build/command').runCommand;",
    "function runCommand(input) { return input; } runCommand(input);",
    `${runnerImport}\nfunction f(runCommand) { runCommand(anything); }`,
    `const fixture = ${JSON.stringify(permission)}; /* ${permission} */`,
  ])('allows types, shadowed local values, and string fixtures: %s', code => {
    expect(ids({ code })).toEqual([]);
  });

  it('accepts leading comments with BOM, shebang, CRLF, and ordinary comments', () => {
    const code = `\ufeff#!/usr/bin/env node\r\n// @vitest-environment node\r\n/* header */\r\n${permitted({ body: call })}`;
    expect(ids({ code })).toEqual([]);
  });

  it('requires a standalone permission line', () => {
    const code = permitted({ body: call }).replace(permission, `/* ordinary */ ${permission}`);
    expect(ids({ code })).toContain('malformedPermission');
  });

  it('supports leading permissions in a Vue script', () => {
    const code = `<script setup lang="ts">\n${permitted({ body: call })}\n</script>`;
    expect(ids({ code, filename: 'src/Example.vue' })).toEqual([]);
  });

  it('checks actual Vue template references without treating parser bookkeeping as escape', () => {
    const script = `<script setup lang="ts">\n${permission}\n${runnerImport}\n</script>`;
    const direct = `<template><button @click="runCommand({ argv: ['git', 'diff'], options: undefined })">Run</button></template>${script}`;
    expect(ids({ code: direct, filename: 'src/Example.vue' })).toEqual([]);
    const bare = `<template><button @click="runCommand">Run</button></template>${script}`;
    expect(ids({ code: bare, filename: 'src/Example.vue' })).toContain('runnerEscape');
    const mismatch = direct.replace("'diff'", "'push'");
    expect(ids({ code: mismatch, filename: 'src/Example.vue' })).toContain('mismatchedPermission');
  });

  it('retains the Docs command prohibition even with a matching declaration', () => {
    expect(ids({ code: permitted({ body: call }).replace('../build/command', '../../build/command'), filename: 'docs/src/example.test.ts' })).toContain('docsCommand');
  });
});

describe('raw command execution boundary', () => {
  it.each([
    "import { spawn } from 'node:child_process';",
    "import { spawn as execute } from 'child_process';",
    "import * as processes from 'node:child_process';",
    "import cluster from 'cluster';",
    "export { spawn } from 'node:child_process';",
    "export * from 'node:cluster';",
    "require('child_process');",
    "const load = require; load('child_' + 'process');",
    "const filename = require.resolve('child_process'); require(filename);",
    "const filename = import.meta.resolve('execa'); import(filename);",
    "const name = 'node:child_process'; import(name);",
    "import cp = require('child_process');",
    "import { createRequire as cr } from 'node:module'; const load = cr(import.meta.url); load('child_process');",
    "import * as module from 'node:module'; const { createRequire: cr = fallback } = module; const load = cr(import.meta.url); load('child_process');",
    "const { getBuiltinModule: load = fallback } = process; load('child_process');",
    "const { mainModule: { require: load } } = process; load('child_process');",
    "import proc from 'node:process'; const load = proc.getBuiltinModule; load('child_process');",
    "const { ...proc } = process; proc.getBuiltinModule('cluster');",
    "process.binding('spawn_sync');",
    "process._linkedBinding('process_wrap');",
    "Bun.spawn(['git']);",
    "import { spawn as execute } from 'bun'; execute(['git']);",
    "import * as bun from 'bun'; bun.spawn(['git']);",
    "import { $ } from 'bun'; $`git diff`;",
    "const { $: shell } = Bun; shell`git diff`;",
    "export { spawn as execute } from 'bun';",
    "const { spawn: launch = fallback } = Bun; launch(['git']);",
    "new Deno.Command('git');",
    "const { Command: Run = Fallback } = Deno; new Run('git');",
    "Deno.run({ cmd: ['git'] });",
    "vi.importActual('child_process');",
    "import * as tests from 'vitest'; const { importMock: load } = tests.vi; load('child_process');",
    "vi.mock('child_process', async importOriginal => await importOriginal());",
    "vi.mock('child_process', importOriginal => ({ load: importOriginal }));",
    ...['execa', 'cross-spawn', 'shelljs', 'zx', 'foreground-child', 'tinyexec'].flatMap(module => [
      `import launcher from '${module}';`,
      `require('${module}/entry');`,
    ]),
  ])('rejects known host execution entry: %s', code => {
    expect(ids({ code })).toContain('rawCommandEntry');
  });

  it.each([
    "import type { ChildProcess } from 'node:child_process';",
    "import { type ChildProcess } from 'child_process';",
    "export type { ChildProcess } from 'child_process';",
    "type Process = import('child_process').ChildProcess;",
    "const require = () => ({}); require('child_process');",
    "function f(process) { process.getBuiltinModule('child_process'); }",
    "const Bun = { spawn() {} }; Bun.spawn();",
    "const Wesh = { kernel: { spawn() {} } }; Wesh.kernel.spawn('git');",
    "const fixture = `import { spawn } from 'child_process';`;",
    "import(dynamicModuleUrl);",
    "process.getBuiltinModule('fs');",
    "import { file } from 'bun'; file('fixture');",
    "import * as bun from 'bun'; bun.file('fixture');",
    "import type { Subprocess } from 'bun';",
    "vi.mock('child_process');",
    "vi.mock('child_process', { spy: true });",
    "vi.mock('child_process', () => ({ spawn: spy }));",
    "vi.mock(import('child_process'), () => ({ spawn: spy }));",
    "vi.mock(import('./ordinary-module'), factory);",
  ])('allows command-free source without broad loader restrictions: %s', code => {
    expect(ids({ code })).toEqual([]);
  });

  it('permits only named spawn bindings at the exact common runner sink', () => {
    const prefix = "import { spawn, spawnSync as sync } from 'node:child_process';";
    const body = "export function runCommand() { return spawn(executable, args, options); } export function runCommandSync() { return sync(executable, args, options); }";
    expect(ids({ code: `${prefix} ${body}`, filename: 'build/command.ts' })).toEqual([]);
    expect(ids({ code: `${prefix} ${body}`, filename: 'src/command.ts' })).toContain('rawCommandEntry');
    for (const bad of [
      "import * as raw from 'child_process';",
      "import { execFileSync } from 'child_process';",
      "import { spawn } from 'child_process'; const execute = spawn;",
      "import { spawn } from 'child_process'; spawn(executable);",
      "import { spawn } from 'child_process'; export function extra() { return spawn(executable); }",
      "import { spawn } from 'child_process'; export function runCommand() { spawn(executable); spawn(executable); }",
      "export { spawn } from 'child_process';",
    ]) {
      expect(ids({ code: bad, filename: 'build/command.ts' })).toContain('rawCommandEntry');
    }
  });
});
