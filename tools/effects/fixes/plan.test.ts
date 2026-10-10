import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createFixture } from '../test-support/project-fixture.ts';
import { planEffectFix } from './plan.ts';
import { applyEffectFix } from './apply.ts';
import { createEffectsProgram, effectProgramInputs } from '../project.ts';

function fixFixture({ source }: { source: string }) {
  return createFixture({ files: { 'main.ts': source }, entries: ['main.ts'] });
}

describe('effect edit plans', () => {
  it.each([
    'function create() { return () => localStorage.clear(); }',
    'function create() { throw () => localStorage.clear(); }',
    'const select = () => () => localStorage.clear();',
    'const actions = { run: () => localStorage.clear() };',
    // Construct CRLF explicitly so repository formatters cannot normalize the fixture.
    ['function create() {', '  return () => localStorage.clear();', '}', ''].join(String.fromCharCode(13, 10)),  ])('keeps executable code stable for %s', source => {
    const fixture = fixFixture({ source });
    try {
      const result = fixture.fix();
      expect(result.analysis.diagnostics).toEqual([]);
      expect(result.changedFiles).toHaveLength(1);
      expect(fixture.fix().changedFiles).toEqual([]);
    } finally {
      fixture.dispose();
    }
  });

  it('never writes a plan after an unrelated analyzed dependency changes', () => {
    const fixture = createFixture({ files: { 'main.ts': "import { save } from './dep'; function run() { save(); }", 'dep.ts': '/** @effects `localstorage.write(*)` */ export function save() { localStorage.clear(); }' }, entries: ['main.ts'] });
    try {
      const before = fs.readFileSync(path.join(fixture.root, 'main.ts'), 'utf8');
      const plan = planEffectFix({ analysis: fixture.check() });
      fs.appendFileSync(path.join(fixture.root, 'dep.ts'), '\n// external change');
      expect(() => applyEffectFix({ root: fixture.root, plan })).toThrow('changed after analysis');
      expect(fs.readFileSync(path.join(fixture.root, 'main.ts'), 'utf8')).toBe(before);
    } finally {
      fixture.dispose();
    }
  });

  it('snapshots inherited TypeScript configuration, not only edited source files', () => {
    const fixture = fixFixture({ source: 'function inspect() {}' });
    try {
      fs.writeFileSync(path.join(fixture.root, 'base.json'), JSON.stringify({ compilerOptions: { strict: true } }));
      fs.writeFileSync(path.join(fixture.root, 'tsconfig.json'), JSON.stringify({ extends: './base.json', compilerOptions: { noEmit: true, types: [] }, files: ['main.ts'] }));
      const program = createEffectsProgram({ root: fixture.root, config: fixture.config, overlays: new Map() });
      const inputs = effectProgramInputs({ program });
      expect(inputs.has(path.join(fixture.root, 'base.json'))).toBe(true);
      fs.appendFileSync(path.join(fixture.root, 'base.json'), '\n');
      expect(() => applyEffectFix({ root: fixture.root, plan: { edits: [], snapshots: inputs } })).toThrow('changed after analysis');
    } finally {
      fixture.dispose();
    }
  });

  it('rolls back a first replacement when a subsequent rename fails', () => {
    const fixture = createFixture({ files: { 'main.ts': "import { save } from './dep'; function run() { save(); }", 'dep.ts': 'export function save() { localStorage.clear(); }' }, entries: ['main.ts'] });
    try {
      const plan = planEffectFix({ analysis: fixture.check() });
      const rename = fs.renameSync;
      let calls = 0;
      const spy = vi.spyOn(fs, 'renameSync').mockImplementation((source, destination) => {
        if (++calls === 2) throw new Error('Injected rename failure');
        rename(source, destination);
      });
      try {
        expect(() => applyEffectFix({ root: fixture.root, plan })).toThrow('rolled back');
      } finally {
        spy.mockRestore();
      }
      for (const edit of plan.edits) expect(fs.readFileSync(edit.file, 'utf8')).toBe(edit.before);
      expect(fs.readdirSync(fixture.root).some(file => file.startsWith('.effects-'))).toBe(false);
    } finally {
      fixture.dispose();
    }
  });
});
