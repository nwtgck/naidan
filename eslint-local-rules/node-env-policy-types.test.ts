// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { Linter } from 'eslint';
import parser from '@typescript-eslint/parser';
import ts from 'typescript';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import policy from './node-env-policy.js';

const repoRoot = path.resolve(import.meta.dirname, '..');

describe('optional actual TypeScript process provenance', () => {
  it('rejects inferred Node processes without mistaking virtual processes or plain environment objects', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'naidan-env-type-'));
    using fixture = {
      [Symbol.dispose]() {
        rmSync(directory, { recursive: true, force: true });
      },
    };
    const filename = path.join(directory, 'example.ts');
    const code = `\
type Process = NodeJS.Process;
declare function obtain(): Process;
obtain().env.X;
const native = [obtain()];
native.map(p => p.env.X);
function read(p: Process) { return p.env.X; }
interface WeshProcess { env: Map<string, string> }
const virtual: WeshProcess[] = [];
virtual.map(process => process.env.get('USER'));
function update(process: WeshProcess) { process.env.set('X', 'value'); }
const environment: NodeJS.ProcessEnv = {};
environment.X = 'value';
delete environment.X;
const plain = { env: new Map<string, string>() };
plain.env.set('X', 'value');
`;
    writeFileSync(filename, code);
    const program = ts.createProgram([filename], {
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      types: ['node'],
      typeRoots: [path.join(repoRoot, 'node_modules/@types')],
      skipLibCheck: true,
      strict: true,
      noEmit: true,
    });
    expect(ts.getPreEmitDiagnostics(program).map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))).toEqual([]);
    const messages = new Linter({ cwd: directory }).verify(code, [{
      ...policy,
      languageOptions: { parser, parserOptions: { programs: [program] } },
    }], { filename });
    expect(messages.filter(message => message.fatal)).toEqual([]);
    expect(messages.map(message => [message.line, message.messageId])).toEqual([
      [3, 'directEnvironment'],
      [5, 'directEnvironment'],
      [6, 'directEnvironment'],
    ]);
  });
});
