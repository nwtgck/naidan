import { describe, expect, it } from 'vitest';
import { assertFileProtocolStandaloneClassicScript } from './javascript-validation';

describe('file protocol standalone JavaScript validation', () => {
  it('counts System.register calls and hosted Worker URLs without matching similar syntax', () => {
    expect(assertFileProtocolStandaloneClassicScript({
      source: `\
#! /usr/bin/env node
System.register([], function () {});
System['register']([], function () {});
Other.register([], function () {});
const text = 'System.register([], function () {})';
// System.register([], function () {});
new Worker(new URL('./worker.js', location.href));
new Other(new URL('./worker.js', location.href));
`,
      label: 'support script',
      mode: 'support-script',
    })).toEqual({
      runtimeDynamicImports: [],
      systemRegisterCallCount: 2,
      hostedWorkerUrlCount: 1,
    });
  });

  it('keeps UTF-16 line and column positions for dynamic Worker imports', () => {
    expect(assertFileProtocolStandaloneClassicScript({
      source: `\
// 日本語😀
const prefix = '😀'; void import(specifier);
`,
      label: 'worker helper',
      mode: 'worker',
    })).toEqual({
      runtimeDynamicImports: [{
        kind: 'dynamic-specifier',
        line: 2,
        column: 26,
        specifier: undefined,
      }],
      systemRegisterCallCount: 0,
      hostedWorkerUrlCount: 0,
    });
  });

  it.each([
    { name: 'LF', lineTerminator: '\n' },
    { name: 'CRLF', lineTerminator: '\r\n' },
    { name: 'CR', lineTerminator: '\r' },
    { name: 'line separator', lineTerminator: '\u2028' },
    { name: 'paragraph separator', lineTerminator: '\u2029' },
  ])('keeps dynamic import positions after $name', ({ lineTerminator }) => {
    expect(assertFileProtocolStandaloneClassicScript({
      source: `first();${lineTerminator}void import(specifier);`,
      label: 'worker helper',
      mode: 'worker',
    }).runtimeDynamicImports).toEqual([{
      kind: 'dynamic-specifier',
      line: 2,
      column: 5,
      specifier: undefined,
    }]);
  });

  it('treats literal and expression-free template imports as static Worker imports', () => {
    expect(() => assertFileProtocolStandaloneClassicScript({
      source: `\
void import('./literal.js');
void import(\`./template.js\`);
void import(\`./${'${specifier}'}.js\`);
`,
      label: 'worker chunk',
      mode: 'worker',
    })).toThrow('2 unsupported runtime import expression(s) remain');
  });

  it.each([
    {
      name: 'import.meta',
      source: 'void import.meta.url;',
      expectedError: /import\.meta/,
    },
    {
      name: 'static import',
      source: "import value from './value.js';",
      expectedError: /import statement outside a module/,
    },
    {
      name: 'export',
      source: 'export const value = 1;',
      expectedError: /export statement outside a module/,
    },
    {
      name: 'top-level await',
      source: 'await Promise.resolve();',
      expectedError: /`await` is only allowed/,
    },
    {
      name: 'invalid syntax',
      source: 'const = ;',
      expectedError: /Unexpected token/,
    },
  ])('rejects $name before traversing the recovered AST', ({ source, expectedError }) => {
    expect(() => assertFileProtocolStandaloneClassicScript({
      source,
      label: 'invalid classic script',
      mode: 'support-script',
    })).toThrow(expectedError);
  });
});
