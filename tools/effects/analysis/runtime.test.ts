import vm from 'node:vm';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { createFixture } from '../test-support/project-fixture.ts';

const hooks = `\
const tricky = {
  /** @effects \`localstorage.write(*)\` */
  toString() { localStorage.clear(); return '2'; },
};
`;

describe('runtime witnesses for implicit operations', () => {
  it.each([
    'String(tricky);',
    '"123".includes(tricky as unknown as string);',
    'new Error(tricky as unknown as string);',
    'const text = `${tricky}`; void text;',
    'const number = +(tricky as unknown as number); void number;',
    'const number = (tricky as unknown as number) + 1; void number;',
  ])('does not certify a TypeScript-valid hidden conversion: %s', expression => {
    const source = `${hooks}\n/** @effects \`none\` */ function run() { ${expression} }\nrun();`;
    const fixture = createFixture({ files: { 'main.ts': source }, entries: ['main.ts'] });
    try {
      const analysis = fixture.check();
      expect(analysis.diagnostics.filter(item => item.code === 'typescript')).toEqual([]);
      expect(analysis.diagnostics.some(item => item.code === 'unsupported')).toBe(true);
      let writes = 0;
      const output = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.None } }).outputText;
      vm.runInNewContext(output, {
        localStorage: {
          clear: () => {
            writes++;
          },
        },
      }, { timeout: 1000 });
      expect(writes).toBe(1);
    } finally {
      fixture.dispose();
    }
  });

  it('charges executing a stored function, not installing it', () => {
    const source = `\
const actions = { /** @effects \`localstorage.write(*)\`, \`hoge\` */ run: () => {} };
/** @effects \`localstorage.write(*)\` */ function writer() { localStorage.clear(); }
/** @effects \`none\` */ function install() { actions.run = writer; }
/** @effects \`localstorage.write(*)\`, \`hoge\` */ function execute() { actions.run(); }
`;
    const fixture = createFixture({ files: { 'main.ts': source }, entries: ['main.ts'] });
    try {
      expect(fixture.check().diagnostics).toEqual([]);
      let writes = 0;
      const context = vm.createContext({
        localStorage: {
          clear: () => {
            writes++;
          },
        },
      });
      vm.runInContext(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.None } }).outputText, context, { timeout: 1000 });
      vm.runInContext('install()', context, { timeout: 1000 }); expect(writes).toBe(0);
      vm.runInContext('execute()', context, { timeout: 1000 }); expect(writes).toBe(1);
    } finally {
      fixture.dispose();
    }
  });
});
