import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import productionConfig from '../../../effects.config.ts';
import { createEffectsProgram, typescriptDiagnostics } from '../project.ts';
import { analyzeEffects } from '../index.ts';
import { planEffectFix } from '../fixes/plan.ts';
import { printEffect } from '../contracts/effects.ts';
import { UNVERIFIED_EFFECT_NOTE } from '../maintenance/unverified.ts';

const root = path.resolve(import.meta.dirname, '../../..');
const probeBoundaryMessage = 'Global property showDirectoryPicker needs a checked default-library identity; a member name is not a native model.';
const probeBoundaryStart = fs.readFileSync(path.join(root, 'src/utils/opfs-detection.ts'), 'utf8').indexOf('.showDirectoryPicker') + 1;
const file = path.join(root, 'src/utils/opfs-detection.ts');
const config = { ...productionConfig, files: ['src/utils/opfs-detection.ts'] };

function check({ source }: { source: string | undefined }) {
  const overlays = source === undefined ? new Map() : new Map([[file, source]]);
  const program = createEffectsProgram({ root, config, overlays });
  expect(typescriptDiagnostics({ program })).toEqual([]);
  const analysis = analyzeEffects({ program, root, config });
  // Keep the real draft warnings asserted without masking any probe
  // diagnostic or removing its marker from source/overlays.
  const markers = ['src/utils/opfs-detection.ts'];
  expect(analysis.diagnostics.filter(item => item.message === UNVERIFIED_EFFECT_NOTE).map(item => item.file).sort()).toEqual(markers.map(file => path.join(root, file)).sort());
  const initializers = analysis.diagnostics.filter(item => item.message.startsWith('Runtime import initialization'));
  expect(initializers).toEqual([]);
  expect(initializers.every(item => item.code === 'unsupported')).toBe(true);
  const boundaries = analysis.diagnostics.filter(item => item.code === 'boundary' && item.message === probeBoundaryMessage);
  expect(boundaries.map(item => ({ file: item.file, message: item.message, start: item.start, length: item.length }))).toEqual(analysis.coverage.files.includes(path.join(root, 'src/utils/opfs-detection.ts'))
    ? [{ file: path.join(root, 'src/utils/opfs-detection.ts'), message: probeBoundaryMessage, start: probeBoundaryStart, length: 'showDirectoryPicker'.length }] : []);

  // These source regressions inspect callable rows only after asserting that
  // strict checking still reports every draft, unknown initializer and native-identity boundary.
  return { ...analysis, diagnostics: analysis.diagnostics.filter(item => item.message !== UNVERIFIED_EFFECT_NOTE && !initializers.includes(item) && !boundaries.includes(item)) };
}

describe('real OPFS capability-probe exception', () => {
  it('retains read/write evidence while publishing none for the real function', () => {
    const analysis = check({ source: undefined });
    expect(analysis.diagnostics).toEqual([]);
    expect(planEffectFix({ analysis }).edits).toEqual([]);
    const audit = analysis.unsafeSuppressions.find(item => item.label === 'checkOPFSSupport')!;
    expect(audit).toBeDefined();
    expect(audit.body.map(effect => printEffect({ effect }))).toEqual(['opfs.read(*)', 'opfs.write(*)']);
    expect(audit.suppressed).toEqual(audit.body);
    expect(audit.outward).toEqual([]);
    expect(audit.reason).toContain('best-effort');
  });

  it('exposes added network work and preserves the reviewed OPFS exception during fix', () => {
    const original = fs.readFileSync(file, 'utf8');
    const source = original.replace('export async function checkOPFSSupport(): Promise<boolean> {', "export async function checkOPFSSupport(): Promise<boolean> { await fetch('/unexpected');")
      + '\n/** @effects [] */ export async function callerForEffectTest() { return checkOPFSSupport(); }\n';
    const analysis = check({ source });
    expect(analysis.diagnostics.filter(item => item.code !== 'exceeds')).toEqual([]);
    const audit = analysis.unsafeSuppressions[0]!;
    expect(audit.outward.map(effect => printEffect({ effect }))).toEqual(['network.http(*)']);
    const edits = planEffectFix({ analysis }).edits;
    expect(edits).toHaveLength(1);
    expect(edits[0]!.after).toContain('@effectsUNSAFE {"effects":["opfs.read(*)","opfs.write(*)"]');
    const after = check({ source: edits[0]!.after });
    expect(after.diagnostics).toEqual([]);
    expect(planEffectFix({ analysis: after }).edits).toEqual([]);
    expect(fs.readFileSync(file, 'utf8')).toBe(original);
  });

  it('detects stale exceptions after removal of the actual probe body', () => {
    const original = fs.readFileSync(file, 'utf8');
    const start = original.indexOf('export async function checkOPFSSupport()');
    const end = original.indexOf('// Export internal state', start);
    const source = original.slice(0, start) + 'export async function checkOPFSSupport(): Promise<boolean> { return false; }\n\n' + original.slice(end);
    const analysis = check({ source });
    expect(analysis.diagnostics.filter(item => item.message.startsWith('Unused unsafe'))).toHaveLength(2);
    expect(() => planEffectFix({ analysis })).toThrow('refused');
    expect(fs.readFileSync(file, 'utf8')).toBe(original);
  });
});

describe('the real probe still performs suppressed operations', () => {
  it.each(['success', 'failure'] as const)('does not disguise best-effort cleanup: %s', cleanup => {
    let created = 0;
    let removed = 0;
    const exported: { checkOPFSSupport?: () => Promise<boolean> } = {};
    const output = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
      compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS },
    });
    vm.runInNewContext(output.outputText, {
      exports: exported,
      console: { warn() {} },
      navigator: {
        storage: {
          async getDirectory() {
            return {
              async getFileHandle() {
                created++; return { createWritable() {} };
              },
              async removeEntry() {
                if (cleanup === 'failure') throw new Error('Deliberate cleanup failure.');
                removed++;
              },
            };
          },
        },
      },
    });
    const probe = exported.checkOPFSSupport;
    if (typeof probe !== 'function') throw new Error('Missing real probe export.');
    return probe().then(result => {
      expect(result).toBe(true);
      expect(created).toBe(1);
      expect(removed).toBe(cleanup === 'success' ? 1 : 0);
    });
  });
});
