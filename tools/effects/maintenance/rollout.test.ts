import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import config from '../../../effects.config.ts';
import { EffectsAnalyzer } from '../analysis/analyze.ts';
import { analyzeEffects } from '../index.ts';
import { createEffectsProgram, typescriptDiagnostics } from '../project.ts';
import { runEffectTidy } from './tidy.ts';
import { planEffectRows, planEffectFix } from '../fixes/plan.ts';

const root = path.resolve(import.meta.dirname, '../../..');

describe('maintenance on the enrolled Naidan modules', () => {
  it('previews the actual scope with no changes and keeps the existing unsafe exception', () => {
    const result = runEffectTidy({ root, config, files: config.files, write: 'preview', inputSnapshots: new Map() });
    expect(result.analysis.diagnostics).toEqual([]);
    expect(result.edits).toEqual([]);
    expect(result.analysis.coverage.files).toHaveLength(6);
    expect(result.analysis.unsafeSuppressions).toHaveLength(1);
    expect(result.selections.some(item => item.disposition === 'infer')).toBe(true);
    expect(result.selections.some(item => item.disposition === 'preserve')).toBe(true);
  });

  it('removes injected broad annotations using real code without altering or writing executable source', () => {
    const file = path.join(root, 'src/composables/useCodeBlockSettings.ts');
    const original = fs.readFileSync(file, 'utf8');
    const broad = original.replaceAll('/** @effects `none` */', '/** @effects `network.http(*)` */');
    expect(broad).not.toBe(original);
    const program = createEffectsProgram({ root, config, overlays: new Map([[file, broad]]) });
    expect(typescriptDiagnostics({ program })).toEqual([]);
    const result = new EffectsAnalyzer({ root, config, program }).analyzeForTidy({ files: new Set([file]) });
    expect(result.analysis.diagnostics).toEqual([]);
    const chosen = new Set(result.selections.filter(item => item.disposition === 'infer').map(item => item.owner));
    const plan = planEffectRows({
      owners: result.analysis.owners.filter(owner => chosen.has(owner.id)),
      rows: result.analysis.solution.rows,
      sources: result.analysis.sources,
    });
    expect(plan.edits).toHaveLength(1);
    expect(plan.edits[0]?.after).toBe(original);
    const projected = createEffectsProgram({ root, config, overlays: new Map(plan.edits.map(edit => [edit.file, edit.after])) });
    const checked = analyzeEffects({ root, config, program: projected });
    expect(checked.diagnostics).toEqual([]);
    expect(planEffectFix({ analysis: checked }).edits).toEqual([]);
    expect(fs.readFileSync(file, 'utf8')).toBe(original);
  });
});
