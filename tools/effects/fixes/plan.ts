import path from 'node:path';
import type { ContractOwner } from '../analysis/values.ts';
import type { Effect } from '../contracts/effects.ts';
import type { EffectsAnalysis } from '../analysis/analyze.ts';
import { printEffects } from '../syntax/expression.ts';

export type EffectFileEdit = { file: string, before: string, after: string };
export type EffectFixPlan = { edits: readonly EffectFileEdit[], snapshots: ReadonlyMap<string, string> };

export function planEffectFix({ analysis }: { analysis: EffectsAnalysis }): EffectFixPlan {
  const blockers = analysis.diagnostics.filter(diagnostic => diagnostic.code !== 'missing' && diagnostic.code !== 'exceeds');
  if (blockers.length > 0) throw new Error('Effect fix refused: syntax, type, boundary or unsupported diagnostics remain.');
  return planEffectRows({ owners: analysis.owners, rows: analysis.solution.rows, sources: analysis.sources });
}

export function planEffectRows({ owners, rows, sources }: {
  owners: readonly ContractOwner[], rows: ReadonlyMap<number, readonly Effect[]>, sources: ReadonlyMap<string, string>,
}): EffectFixPlan {
  const ranges = new Map<string, { start: number, end: number, text: string }[]>();
  for (const owner of owners) {
    if (owner.role === 'symbolic' || owner.role === 'module' || owner.role === 'body') continue;
    const effects = rows.get(owner.id) ?? [];
    const row = printEffects({ effects });
    if (owner.annotation !== undefined && printEffects({ effects: owner.declared }) === row) continue;
    const file = path.resolve(owner.location.file);
    const source = sources.get(file);
    if (source === undefined) throw new Error('Missing source snapshot for an effect edit.');
    const start = owner.annotation?.start ?? owner.anchor.getStart(owner.anchor.getSourceFile());
    const end = owner.annotation?.end ?? start;
    const lineStart = source.lastIndexOf('\n', start - 1) + 1;
    const indentation = source.slice(lineStart, start);
    const standalone = [...indentation].every(character => character === ' ' || character === '\t');
    const newline = source.includes('\r\n') ? '\r\n' : '\n';
    // Never insert a line terminator after return/throw/yield or inside an arrow expression.
    const suffix = owner.annotation === undefined ? standalone ? newline + indentation : ' ' : '';
    const items = ranges.get(file) ?? [];
    items.push({ start, end, text: `/** @effects ${row} */${suffix}` });
    ranges.set(file, items);
  }
  const edits: EffectFileEdit[] = [];
  for (const [file, items] of ranges) {
    const before = sources.get(file)!;
    const ordered = [...items].sort((a, b) => a.start - b.start || a.end - b.end);
    const chunks: string[] = [];
    let cursor = 0;
    let previousStart = -1;
    for (const item of ordered) {
      if (item.start < cursor || item.start === previousStart) throw new Error(`Overlapping effect edits in ${file}.`);
      chunks.push(before.slice(cursor, item.start), item.text);
      cursor = item.end;
      previousStart = item.start;
    }
    chunks.push(before.slice(cursor));
    const after = chunks.join('');
    if (before !== after) edits.push({ file, before, after });
  }
  return { edits, snapshots: sources };
}
