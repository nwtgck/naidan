import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Wesh } from '@/features/wesh/index';
import { createTextShellSource } from '@/features/wesh/shell/source';
import { MockFileSystemDirectoryHandle } from '@/features/wesh/mocks/InMemoryFileSystem';
import {
  createTestReadHandleFromText,
  createTestWriteCaptureHandle,
} from '@/features/wesh/utils/test-stream';
import { nodeCommandDefinition } from './definition';
import { NODE_CHECK_ONLY_ERROR } from './argv';

beforeAll(async () => {
  await nodeCommandDefinition.load();
});

describe('wesh node --check', () => {
  let wesh: Wesh;
  let rootHandle: MockFileSystemDirectoryHandle;

  beforeEach(async () => {
    rootHandle = new MockFileSystemDirectoryHandle({ name: 'root' });
    wesh = new Wesh({ rootHandle: rootHandle as unknown as FileSystemDirectoryHandle });
    await wesh.init();
  });

  async function writeFile({
    path,
    data,
  }: {
    path: string,
    data: string,
  }): Promise<void> {
    const segments = path.split('/').filter((segment) => segment.length > 0);
    const fileName = segments.pop();
    if (fileName === undefined) {
      throw new Error(`File path has no filename: ${path}`);
    }

    let directory = rootHandle;
    for (const segment of segments) {
      directory = await directory.getDirectoryHandle(segment, { create: true });
    }

    const handle = await directory.getFileHandle(fileName, { create: true });
    const writable = await handle.createWritable();
    await writable.write(data);
    await writable.close();
  }

  async function execute({
    script,
    stdinText,
  }: {
    script: string,
    stdinText: string | undefined,
  }) {
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();
    const result = await wesh.execute({
      source: createTextShellSource({ text: script }),
      stdin: createTestReadHandleFromText({ text: stdinText ?? '' }),
      stdout: stdout.handle,
      stderr: stderr.handle,
    });
    return { result, stdout, stderr };
  }

  it('accepts valid JavaScript without executing it', async () => {
    await writeFile({
      path: 'valid.js',
      data: `\
globalThis.__mustNotRun = true;
throw new Error('must not execute');
`,
    });

    const { result, stdout, stderr } = await execute({
      script: 'node --check valid.js',
      stdinText: undefined,
    });

    expect(result.exitCode).toBe(0);
    expect(stdout.text).toBe('');
    expect(stderr.text).toBe('');
  });

  it('supports -c as the short alias', async () => {
    await writeFile({ path: 'valid.js', data: 'const value = 1;\n' });
    const { result, stderr } = await execute({
      script: 'node -c valid.js',
      stdinText: undefined,
    });
    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
  });

  it('reports the source line and caret for syntax errors', async () => {
    await writeFile({ path: 'invalid.js', data: 'const value = ;\n' });
    const { result, stdout, stderr } = await execute({
      script: 'node --check invalid.js',
      stdinText: undefined,
    });

    expect(result.exitCode).toBe(1);
    expect(stdout.text).toBe('');
    expect(stderr.text).toBe(`\
/invalid.js:1
const value = ;
              ^

SyntaxError: Unexpected token ';'
`);
  });

  it('checks stdin when no operand is supplied', async () => {
    const { result, stderr } = await execute({
      script: 'node --check',
      stdinText: 'const value = ;\n',
    });

    expect(result.exitCode).toBe(1);
    expect(stderr.text).toBe(`\
[stdin]:1
const value = ;
              ^

SyntaxError: Unexpected token ';'
`);
  });

  it('checks stdin when the operand is -', async () => {
    const { result, stderr } = await execute({
      script: 'node -c -',
      stdinText: 'const value = 1;\n',
    });
    expect(result.exitCode).toBe(0);
    expect(stderr.text).toBe('');
  });

  it('rejects runtime execution and non-check Node options', async () => {
    await writeFile({ path: 'valid.js', data: 'const value = 1;\n' });

    for (const script of [
      'node valid.js',
      'node -e "1 + 1"',
      'node --version',
      'node --help',
      'node -cc valid.js',
      'node -cfoo valid.js',
    ]) {
      const { result, stdout, stderr } = await execute({ script, stdinText: undefined });
      expect(result.exitCode).toBe(1);
      expect(stdout.text).toBe('');
      expect(stderr.text).toBe(`${NODE_CHECK_ONLY_ERROR}\n`);
    }
  });

  it('accepts Node check spellings that keep script argv after the operand', async () => {
    await writeFile({ path: 'valid.js', data: 'const value = 1;\n' });

    for (const script of [
      'node --check=ignored valid.js',
      'node --check valid.js --not-a-node-option',
      'node -c valid.js -e ignored',
      'node --check -- valid.js --still-script-argv',
    ]) {
      const { result, stderr } = await execute({ script, stdinText: undefined });
      expect(result.exitCode).toBe(0);
      expect(stderr.text).toBe('');
    }
  });

  it('uses module grammar for .mjs and CommonJS grammar for .cjs', async () => {
    await writeFile({ path: 'module.mjs', data: "import value from 'pkg';\n" });
    await writeFile({ path: 'common.cjs', data: "import value from 'pkg';\n" });

    const moduleResult = await execute({
      script: 'node --check module.mjs',
      stdinText: undefined,
    });
    expect(moduleResult.result.exitCode).toBe(0);
    expect(moduleResult.stderr.text).toBe('');

    const commonResult = await execute({
      script: 'node --check common.cjs',
      stdinText: undefined,
    });
    expect(commonResult.result.exitCode).toBe(1);
    expect(commonResult.stderr.text).toBe(`\
/common.cjs:1
import value from 'pkg';
^^^^^^

SyntaxError: Cannot use import statement outside a module
`);
  });

  it('matches ambiguous no-package JavaScript acceptance without weakening explicit CommonJS', async () => {
    await writeFile({
      path: 'ambiguous.js',
      data: `\
let require;
with ({}) {}
await 1;
export {};
`,
    });
    await writeFile({ path: 'strict.cjs', data: 'let require;\n' });

    const ambiguous = await execute({
      script: 'node --check ambiguous.js',
      stdinText: undefined,
    });
    expect(ambiguous.result.exitCode).toBe(0);
    expect(ambiguous.stderr.text).toBe('');

    const common = await execute({
      script: 'node --check strict.cjs',
      stdinText: undefined,
    });
    expect(common.result.exitCode).toBe(1);
    expect(common.stderr.text).toBe(`\
/strict.cjs:1
let require;
    ^

SyntaxError: Identifier 'require' has already been declared
`);
  });

  it('honors package type for .js and extensionless files without applying it to .json', async () => {
    await writeFile({ path: 'esm/package.json', data: '{"type":"module"}\n' });
    await writeFile({ path: 'esm/file.js', data: "import value from 'pkg';\n" });
    await writeFile({ path: 'esm/script', data: 'return 1;\n' });
    await writeFile({ path: 'esm/data.json', data: 'return 1;\n' });
    await writeFile({ path: 'cjs/package.json', data: '{"type":"commonjs"}\n' });
    await writeFile({ path: 'cjs/file.js', data: "import value from 'pkg';\n" });
    await writeFile({ path: 'cjs/script', data: "import value from 'pkg';\n" });

    const esm = await execute({ script: 'node --check esm/file.js', stdinText: undefined });
    expect(esm.result.exitCode).toBe(0);
    expect(esm.stderr.text).toBe('');

    const esmExtensionless = await execute({ script: 'node --check esm/script', stdinText: undefined });
    expect(esmExtensionless.result.exitCode).toBe(1);
    expect(esmExtensionless.stderr.text).toContain('SyntaxError: Illegal return statement');

    const esmJson = await execute({ script: 'node --check esm/data.json', stdinText: undefined });
    expect(esmJson.result.exitCode).toBe(0);
    expect(esmJson.stderr.text).toBe('');

    const cjs = await execute({ script: 'node --check cjs/file.js', stdinText: undefined });
    expect(cjs.result.exitCode).toBe(1);
    expect(cjs.stderr.text).toContain('SyntaxError: Cannot use import statement outside a module');

    const cjsExtensionless = await execute({ script: 'node --check cjs/script', stdinText: undefined });
    expect(cjsExtensionless.result.exitCode).toBe(1);
    expect(cjsExtensionless.stderr.text).toContain('SyntaxError: Cannot use import statement outside a module');
  });

  it('matches package.json validation used by Node syntax detection', async () => {
    await writeFile({ path: 'malformed/package.json', data: '{ invalid\n' });
    await writeFile({ path: 'malformed/file.js', data: 'import x from "x";\n' });
    await writeFile({ path: 'non-string/package.json', data: '{"type":null}\n' });
    await writeFile({ path: 'non-string/file.js', data: 'const x = 1;\n' });
    await writeFile({ path: 'unknown/package.json', data: '{"type":"future-mode"}\n' });
    await writeFile({ path: 'unknown/file.js', data: 'import x from "x";\n' });

    const malformed = await execute({ script: 'node --check malformed/file.js', stdinText: undefined });
    expect(malformed.result.exitCode).toBe(1);
    expect(malformed.stderr.text).toBe('Error: Invalid package config /malformed/package.json.\n');

    const nonString = await execute({ script: 'node --check non-string/file.js', stdinText: undefined });
    expect(nonString.result.exitCode).toBe(1);
    expect(nonString.stderr.text).toBe('Error: Invalid package config /non-string/package.json.\n');

    const unknown = await execute({ script: 'node --check unknown/file.js', stdinText: undefined });
    expect(unknown.result.exitCode).toBe(0);
    expect(unknown.stderr.text).toBe('');
  });

  it('keeps TypeScript out of scope while the reference Node --check rejects it', async () => {
    await writeFile({ path: 'file.ts', data: 'const value: string = "x";\n' });
    const { result, stderr } = await execute({
      script: 'node --check file.ts',
      stdinText: undefined,
    });

    expect(result.exitCode).toBe(1);
    expect(stderr.text).toBe('TypeError [ERR_UNKNOWN_FILE_EXTENSION]: Unknown file extension ".ts" for /file.ts\n');
  });

  it('reports missing input without a fabricated Node internal stack', async () => {
    const { result, stderr } = await execute({
      script: 'node --check missing.js',
      stdinText: undefined,
    });
    expect(result.exitCode).toBe(1);
    expect(stderr.text).toBe("Error: Cannot find module '/missing.js'\n");
  });

  it('renders unterminated templates at the EOF line without scraping Babel messages', async () => {
    await writeFile({ path: 'template.cjs', data: 'const value = `abc\n' });
    const { result, stderr } = await execute({
      script: 'node --check template.cjs',
      stdinText: undefined,
    });

    expect(result.exitCode).toBe(1);
    expect(stderr.text).toBe(`\
/template.cjs:2



SyntaxError: Unexpected end of input
`);
  });

  it('matches stable Node diagnostics for common syntax failures', async () => {
    const cases = [
      {
        path: 'unexpected-arrow.cjs',
        source: '=>x;\n',
        display: `\
=>x;
^^`,
        message: "Unexpected token '=>'",
      },
      {
        path: 'unexpected-spread.cjs',
        source: 'const ...x = 1;\n',
        display: `\
const ...x = 1;
      ^^^`,
        message: "Unexpected token '...'",
      },
      {
        path: 'unexpected-private.cjs',
        source: 'const #x = 1;\n',
        display: `\
const #x = 1;
      ^^`,
        message: "Unexpected identifier '#x'",
      },
      {
        path: 'yield-value.cjs',
        source: 'const x = yield 1;\n',
        display: `\
const x = yield 1;
                ^`,
        message: 'Unexpected number',
      },
      {
        path: 'invalid-radix.cjs',
        source: 'const x = 0x;\n',
        display: `\
const x = 0x;
          ^^`,
        message: 'Invalid or unexpected token',
      },
      {
        path: 'invalid-radix-separator.cjs',
        source: 'const x = 0x_1;\n',
        display: `\
const x = 0x_1;
          ^^`,
        message: 'Invalid or unexpected token',
      },
      {
        path: 'private-object-key.cjs',
        source: 'let x = {#a: 1};\n',
        display: `\
let x = {#a: 1};
         ^^`,
        message: "Unexpected identifier '#a'",
      },
      {
        path: 'partial-application-marker.cjs',
        source: 'let x = [1, ? 2];\n',
        display: `\
let x = [1, ? 2];
            ^`,
        message: "Unexpected token '?'",
      },
      {
        path: 'missing-init.cjs',
        source: 'const x;\n',
        display: `\
const x;
      ^`,
        message: 'Missing initializer in const declaration',
      },
      {
        path: 'dup-constructor.cjs',
        source: 'class A { constructor(){} constructor(){} }\n',
        display: `\
class A { constructor(){} constructor(){} }
                          ^^^^^^^^^^^`,
        message: 'A class may only have one constructor',
      },
      {
        path: 'dup-private.cjs',
        source: 'class A { #x; #x; }\n',
        display: `\
class A { #x; #x; }
                ^`,
        message: "Identifier '#x' has already been declared",
      },
      {
        path: 'break.cjs',
        source: 'break;\n',
        display: `\
break;
^^^^^`,
        message: 'Illegal break statement',
      },
      {
        path: 'continue.cjs',
        source: 'continue;\n',
        display: `\
continue;
^^^^^^^^`,
        message: 'Illegal continue statement: no surrounding iteration statement',
      },
      {
        path: 'invalid-lhs.cjs',
        source: '1 = 2;\n',
        display: `\
1 = 2;
^`,
        message: 'Invalid left-hand side in assignment',
      },
      {
        path: 'optional-chain-lhs.cjs',
        source: 'value?.x = 1;\n',
        display: `\
value?.x = 1;
^^^^^^^^`,
        message: 'Invalid left-hand side in assignment',
      },
      {
        path: 'class-redeclare.cjs',
        source: 'class A{} class A{}\n',
        display: `\
class A{} class A{}
          ^^^^^^^^^`,
        message: "Identifier 'A' has already been declared",
      },
      {
        path: 'private-use.cjs',
        source: 'class A { f(){ return this.#x; } }\n',
        display: `\
class A { f(){ return this.#x; } }
                          ^`,
        message: "Private field '#x' must be declared in an enclosing class",
      },
      {
        path: 'constructor-async.cjs',
        source: 'class A { async constructor(){} }\n',
        display: `\
class A { async constructor(){} }
                ^^^^^^^^^^^`,
        message: 'Class constructor may not be an async method',
      },
      {
        path: 'constructor-generator.cjs',
        source: 'class A { *constructor(){} }\n',
        display: `\
class A { *constructor(){} }
           ^^^^^^^^^^^`,
        message: 'Class constructor may not be a generator',
      },
      {
        path: 'throw-newline.cjs',
        source: `\
throw
1;
`,
        display: `\
throw
^^^^^`,
        message: 'Illegal newline after throw',
      },
      {
        path: 'prefix-update.cjs',
        source: '++1;\n',
        display: `\
++1;
  ^`,
        message: 'Invalid left-hand side expression in prefix operation',
      },
      {
        path: 'postfix-update.cjs',
        source: '1++;\n',
        display: `\
1++;
^`,
        message: 'Invalid left-hand side expression in postfix operation',
      },
      {
        path: 'nullish-mix.cjs',
        source: 'a ?? b || c;\n',
        display: `\
a ?? b || c;
       ^^`,
        message: "Unexpected token '||'",
      },
      {
        path: 'unary-exponentiation.cjs',
        source: '-2 ** 2;\n',
        display: `\
-2 ** 2;
^^^^^`,
        message: 'Unary operator used immediately before exponentiation expression. Parenthesis must be used to disambiguate operator precedence',
      },
      {
        path: 'rest-default.cjs',
        source: 'function f(...x = []) {}\n',
        display: `\
function f(...x = []) {}
                ^`,
        message: 'Rest parameter may not have a default initializer',
      },
      {
        path: 'object-rest-not-last.cjs',
        source: 'const {...x, y} = o;\n',
        display: `\
const {...x, y} = o;
          ^`,
        message: 'Rest element must be last element',
      },
      {
        path: 'invalid-code-point.cjs',
        source: 'const s = "\\u{110000}";\n',
        display: `\
const s = "\\u{110000}";
           ^^^^^^^^^`,
        message: 'Undefined Unicode code-point',
      },
      {
        path: 'numeric-separator-double.cjs',
        source: 'const x = 1__0;\n',
        display: `\
const x = 1__0;
            ^`,
        message: 'Only one underscore is allowed as numeric separator',
      },
      {
        path: 'numeric-separator-tail.cjs',
        source: 'const x = 1_;\n',
        display: `\
const x = 1_;
            ^`,
        message: 'Numeric separators are not allowed at the end of numeric literals',
      },
      {
        path: 'invalid-bigint.cjs',
        source: 'const x = 1.0n;\n',
        display: `\
const x = 1.0n;
          ^^^`,
        message: 'Invalid or unexpected token',
      },
      {
        path: 'dup-proto.cjs',
        source: '({__proto__: 1, __proto__: 2});\n',
        display: `\
({__proto__: 1, __proto__: 2});
                ^^^^^^^^^`,
        message: 'Duplicate __proto__ fields are not allowed in object literals',
      },
      {
        path: 'dup-label.cjs',
        source: 'x: x: ;\n',
        display: `\
x: x: ;
   ^`,
        message: "Label 'x' has already been declared",
      },
      {
        path: 'strict-eval.cjs',
        source: '"use strict"; let eval;\n',
        display: `\
"use strict"; let eval;
                  ^^^^`,
        message: 'Unexpected eval or arguments in strict mode',
      },
      {
        path: 'super.cjs',
        source: 'super.x;\n',
        display: `\
super.x;
^^^^^`,
        message: "'super' keyword unexpected here",
      },
      {
        path: 'regex-flags.cjs',
        source: '/x/gg;\n',
        display: `\
/x/gg;
^`,
        message: 'Invalid regular expression flags',
      },
      {
        path: 'rest-array.cjs',
        source: '[...x, y] = z;\n',
        display: `\
[...x, y] = z;
 ^^^^`,
        message: 'Rest element must be last element',
      },
      {
        path: 'rest-param.cjs',
        source: 'function f(...x, y) {}\n',
        display: `\
function f(...x, y) {}
               ^`,
        message: 'Rest parameter must be last formal parameter',
      },
      {
        path: 'dup-param.cjs',
        source: '"use strict"; function f(x, x) {}\n',
        display: `\
"use strict"; function f(x, x) {}
                            ^`,
        message: 'Duplicate parameter name not allowed in this context',
      },
      {
        path: 'strict-octal.mjs',
        source: 'const x = 077;\n',
        display: `\
const x = 077;
          ^^^`,
        message: 'Octal literals are not allowed in strict mode.',
      },
      {
        path: 'strict-delete.mjs',
        source: 'delete x;\n',
        display: `\
delete x;
       ^`,
        message: 'Delete of an unqualified identifier in strict mode.',
      },
      {
        path: 'for-await.cjs',
        source: 'for await (const x of y) {}\n',
        display: `\
for await (const x of y) {}
    ^^^^^`,
        message: 'Unexpected reserved word',
      },
    ] as const;

    for (const testCase of cases) {
      await writeFile({ path: testCase.path, data: testCase.source });
      const { result, stderr } = await execute({
        script: `node --check ${testCase.path}`,
        stdinText: undefined,
      });
      expect(result.exitCode, testCase.path).toBe(1);
      expect(stderr.text, testCase.path).toBe(`/${testCase.path}:1\n${testCase.display}\n\nSyntaxError: ${testCase.message}\n`);
    }
  });

  it('preserves tabs before the caret', async () => {
    await writeFile({ path: 'tabs.cjs', data: '\tconst value = ;\n' });
    const { result, stderr } = await execute({
      script: 'node --check tabs.cjs',
      stdinText: undefined,
    });

    expect(result.exitCode).toBe(1);
    expect(stderr.text).toContain('\t              ^\n');
  });
});
