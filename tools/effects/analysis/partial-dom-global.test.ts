import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { printEffect } from '../contracts/effects.ts';
import { planVerifiedEffectFix } from '../maintenance/unverified.ts';
import { createFixture } from '../test-support/project-fixture.ts';

const cases = [
  { name: 'compatible storage bare', globals: 'export {}; declare global { var localStorage: Storage; }', body: "localStorage.setItem('x','saved');", expected: ['localstorage.write(*)'] },
  { name: 'compatible storage qualified', globals: 'export {}; declare global { var localStorage: Storage; }', body: "globalThis.localStorage.setItem('x','saved');", expected: ['localstorage.write(*)'] },
  { name: 'compatible navigator bare', globals: 'export {}; declare global { var navigator: Navigator; }', body: "const root = await navigator.storage.getDirectory(); await root.getDirectoryHandle('naidan-storage',{create:true});", expected: ['opfs.read(*)', 'opfs.write(*)'] },
  { name: 'compatible navigator qualified', globals: 'export {}; declare global { var navigator: Navigator; }', body: "const root = await globalThis.navigator.storage.getDirectory(); await root.getDirectoryHandle('naidan-storage',{create:true});", expected: ['opfs.read(*)', 'opfs.write(*)'] },
  { name: 'real Node duplicate storage', node: true, body: "localStorage.setItem('x','saved');", expected: ['localstorage.write(*)'] },
  { name: 'real Node duplicate navigator', node: true, body: "const root = await globalThis.navigator.storage.getDirectory(); await root.getDirectoryHandle('naidan-storage',{create:true});", expected: ['opfs.read(*)', 'opfs.write(*)'] },
  { name: 'no DOM custom storage', dom: false, globals: 'export {}; declare global { var localStorage: { setItem(key:string,value:string):void }; }', body: "globalThis.localStorage.setItem('x','saved');", expected: [] },
  { name: 'no DOM custom navigator', dom: false, globals: 'export {}; declare global { var navigator: { storage: { getDirectory(): Promise<object> } }; }', body: 'await navigator.storage.getDirectory();', expected: [] },
  { name: 'incompatible DOM storage declaration', skipLibCheck: false, globals: 'export {}; declare global { var localStorage: { setItem(key:string,value:string):number }; }', body: "globalThis.localStorage.setItem('x','saved');", expected: [], invalid: true },
  { name: 'incompatible DOM navigator declaration', skipLibCheck: false, globals: 'export {}; declare global { var navigator: { storage: { getDirectory(): Promise<object> } }; }', body: 'await navigator.storage.getDirectory();', expected: [], invalid: true },
  { name: 'local shadow storage', source: `export {}; const localStorage = { /** @effects ["sessionstorage.write(*)"] */ setItem() { sessionStorage.clear(); } }; /** @effects ["sessionstorage.write(*)"] */ function entry() { localStorage.setItem(); }`, expected: ['sessionstorage.write(*)'] },
  { name: 'cast unknown root', source: `export {}; /** @effects [] */ function entry({ root }: { root: unknown }) { (root as typeof globalThis).localStorage.setItem('x','saved'); }`, expected: [] },
  { name: 'cast fake storage', source: `export {}; const alias = { /** @effects ["sessionstorage.write(*)"] */ setItem() { sessionStorage.clear(); } } as unknown as Storage; /** @effects ["sessionstorage.write(*)"] */ function entry() { alias.setItem('x','saved'); }`, expected: ['sessionstorage.write(*)'] },
  { name: 'external ambient alias', globals: `export declare const alias: Storage;`, source: `import { alias } from './globals'; /** @effects [] */ function entry() { alias.setItem('x','saved'); }`, expected: [] },
  { name: 'fetch excluded', globals: `export {}; declare global { function fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>; }`, body: `await globalThis.fetch('/data');`, expected: [] },
  { name: 'console excluded', globals: `export {}; declare global { var console: Console; }`, body: `globalThis.console.log('x');`, expected: [] },
  { name: 'sessionStorage excluded', globals: `export {}; declare global { var sessionStorage: Storage; }`, body: `globalThis.sessionStorage.clear();`, expected: [] },
  { name: 'callback legality and low budget', budget: 5, globals: 'export {}; declare global { var localStorage: Storage; }', source: `export {}; /** @effects ["call(arg0.verifyPeer)"] */ function entry({ verifyPeer }: { verifyPeer: () => void }) { verifyPeer(); localStorage.clear(); }`, expected: ['call(arg0.verifyPeer)', 'localstorage.write(*)'] },
];

describe('partial DOM candidates in mixed ambient globals', () => {
  it.each(cases)('$name', item => {
    const source = item.source ?? `export {}; /** @effects [] */ async function entry() { ${item.body} }`;
    const fixture = createFixture({ files: { 'main.ts': source, ...(item.globals ? { 'globals.d.ts': item.globals } : {}) }, entries: ['main.ts', ...(item.globals ? ['globals.d.ts'] : [])] });
    try {
      const configPath = path.join(fixture.root, 'tsconfig.json');
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      if (item.dom === false) config.compilerOptions.lib = ['ES2023'];
      if (item.node) {
        config.compilerOptions.types = ['node'];
        config.compilerOptions.typeRoots = [path.resolve('node_modules/@types')];
      }
      if (item.skipLibCheck === false) config.compilerOptions.skipLibCheck = false;
      fs.writeFileSync(configPath, JSON.stringify(config));
      if (item.budget !== undefined) fixture.config.analysisBudget = item.budget;
      const analysis = fixture.check();
      const owner = analysis.owners.find(candidate => candidate.label === 'entry' && candidate.role === 'implementation')!;
      const row = (analysis.solution.rows.get(owner.id) ?? []).map(effect => printEffect({ effect }));
      expect(row).toEqual(item.expected);
      const types = analysis.diagnostics.filter(diagnostic => diagnostic.code === 'typescript');
      if (item.invalid) expect(types.some(diagnostic => diagnostic.message.includes('Subsequent variable declarations'))).toBe(true);
      else expect(types).toEqual([]);
      if (item.globals || item.node) {
        expect(() => planVerifiedEffectFix({ analysis, root: fixture.root })).toThrow();
        expect(analysis.diagnostics.some(diagnostic => diagnostic.code === 'boundary')).toBe(true);
      }
      if (item.name === 'callback legality and low budget') expect([...owner.callbackPaths]).toEqual(['call(arg0.verifyPeer)']);
    } finally {
      fixture.dispose();
    }
  });
});
