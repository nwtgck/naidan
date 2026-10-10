import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createFixture } from '../test-support/project-fixture.ts';
import { planEffectFix } from './plan.ts';
import { applyEffectFix } from './apply.ts';
import { createEffectsProgram, effectProgramInputs } from '../project.ts';
import { planUnresolvedEffectFix } from '../maintenance/unverified.ts';

function fixFixture({ source }: { source: string }) {
  return createFixture({ files: { 'main.ts': source }, entries: ['main.ts'] });
}

describe('effect edit plans', () => {
  it.each([
    '// eslint-disable-next-line local-rule/example -- Reviewed reason.',
    '/* eslint-disable-next-line local-rule/example -- Reviewed reason. */',
    `\
// eslint-disable-next-line local-rule/first
// eslint-disable-next-line local-rule/second`,
  ])('places a new function annotation before next-line directives: %s', directives => {
    const source = '/** Author documentation. */\n' + directives + '\nfunction run() { localStorage.clear(); }';
    const fixture = fixFixture({ source });
    try {
      const result = fixture.fix();
      const after = fs.readFileSync(path.join(fixture.root, 'main.ts'), 'utf8');
      expect(after).toBe(`\
/** Author documentation. */
/** @effects ["localstorage.write(*)"] */
` + directives + '\nfunction run() { localStorage.clear(); }');
      expect(result.analysis.owners.find(owner => owner.label === 'run')?.annotation?.effects).toHaveLength(1);
      expect(result.analysis.diagnostics).toEqual([]);
      expect(fixture.fix().changedFiles).toEqual([]);
    } finally {
      fixture.dispose();
    }
  });

  it('keeps CRLF and indentation around a directive on a nested expression', () => {
    const source = ['const create = () =>', '  // eslint-disable-next-line local-rule/example', '  ({ value }: { value: number }) => value;', ''].join(String.fromCharCode(13, 10));
    const fixture = fixFixture({ source });
    try {
      const result = fixture.fix();
      const after = fs.readFileSync(path.join(fixture.root, 'main.ts'), 'utf8');
      expect(after).toContain(['  /** @effects [] */', '  // eslint-disable-next-line local-rule/example', '  ({ value }: { value: number }) => value;'].join(String.fromCharCode(13, 10)));
      expect(result.analysis.owners.filter(owner => owner.role === 'implementation').every(owner => owner.annotation !== undefined)).toBe(true);
      expect(result.analysis.diagnostics).toEqual([]);
      expect(fixture.fix().changedFiles).toEqual([]);
    } finally {
      fixture.dispose();
    }
  });

  it('updates an existing annotation without relocating it or its author comments', () => {
    const source = `\
/** @effects [] */
// Author explanation remains here.
// eslint-disable-next-line local-rule/example
function run() { localStorage.clear(); }
`;
    const fixture = fixFixture({ source });
    try {
      fixture.fix();
      expect(fs.readFileSync(path.join(fixture.root, 'main.ts'), 'utf8')).toBe(source.replace('/** @effects [] */', '/** @effects ["localstorage.write(*)"] */'));
    } finally {
      fixture.dispose();
    }
  });

  it('shares directive placement with unresolved candidate fixes', () => {
    const directives = '// eslint-disable-next-line local-rule/example -- Keep this target.';
    const fixture = fixFixture({ source: directives + '\nconst run = () => { localStorage.clear(); unmodeled(); };' });
    try {
      const analysis = fixture.check();
      const plan = planUnresolvedEffectFix({ analysis, root: fixture.root, files: analysis.coverage.files, mode: 'fix' });
      expect(plan.edits[0]?.after).toContain('/** @effects ["localstorage.write(*)"] */\n' + directives + '\nconst run');
      applyEffectFix({ root: fixture.root, plan });
      const after = fixture.check();
      expect(after.owners.find(owner => owner.role === 'implementation')?.annotation?.effects).toHaveLength(1);
      expect(planUnresolvedEffectFix({ analysis: after, root: fixture.root, files: after.coverage.files, mode: 'fix' }).edits).toEqual([]);
    } finally {
      fixture.dispose();
    }
  });

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
    const fixture = createFixture({ files: { 'main.ts': "import { save } from './dep'; function run() { save(); }", 'dep.ts': '/** @effects ["localstorage.write(*)"] */ export function save() { localStorage.clear(); }' }, entries: ['main.ts'] });
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
