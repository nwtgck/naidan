import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { EffectFixPlan } from './plan.ts';
import { resolveProjectPath } from '../project.ts';

export function assertEffectSnapshots({ root, plan }: { root: string, plan: EffectFixPlan }): void {
  for (const [file, expected] of plan.snapshots) {
    resolveProjectPath({ root, relative: file });
    if (fs.readFileSync(file, 'utf8') !== expected) throw new Error(`Effect input changed after analysis: ${file}`);
  }
}

/** Per-file atomic replacement, with best-effort rollback; not a filesystem-wide transaction. */
export function applyEffectFix({ root, plan }: { root: string, plan: EffectFixPlan }): void {
  assertEffectSnapshots({ root, plan });
  const prepared: { file: string, temporary: string, before: string, after: string }[] = [];
  const committed: typeof prepared = [];
  try {
    for (const edit of plan.edits) {
      resolveProjectPath({ root, relative: edit.file });
      if (fs.lstatSync(edit.file).isSymbolicLink()) throw new Error(`Refusing to replace a symbolic link: ${edit.file}`);
      const temporary = path.join(path.dirname(edit.file), `.effects-${crypto.randomUUID()}.tmp`);
      fs.writeFileSync(temporary, edit.after, { encoding: 'utf8', flag: 'wx', mode: fs.statSync(edit.file).mode });
      prepared.push({ file: edit.file, temporary, before: edit.before, after: edit.after });
    }
    assertEffectSnapshots({ root, plan });
    for (const edit of prepared) {
      if (fs.readFileSync(edit.file, 'utf8') !== edit.before) throw new Error(`Concurrent effect edit: ${edit.file}`);
      fs.renameSync(edit.temporary, edit.file);
      committed.push(edit);
    }
  } catch (error) {
    const failures: unknown[] = [error];
    for (const edit of committed.reverse()) {
      try {
        if (fs.readFileSync(edit.file, 'utf8') !== edit.after) throw new Error(`Rollback refused after an external change: ${edit.file}`);
        fs.writeFileSync(edit.file, edit.before, 'utf8');
      } catch (rollbackError) {
        failures.push(rollbackError);
      }
    }
    throw new AggregateError(failures, 'Effect fix failed; committed files were rolled back where safe.');
  } finally {
    for (const edit of prepared) if (fs.existsSync(edit.temporary)) fs.unlinkSync(edit.temporary);
  }
}
