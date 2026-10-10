import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { z } from 'zod';

const messageSchema = z.object({
  line: z.number().optional(),
  column: z.number().optional(),
  severity: z.number(),
  ruleId: z.string().nullable(),
  message: z.string(),
});
const resultSchema = z.array(z.object({
  filePath: z.string(),
  errorCount: z.number().int().nonnegative(),
  warningCount: z.number().int().nonnegative(),
  fatalErrorCount: z.number().int().nonnegative(),
  messages: z.array(messageSchema),
}));
export type LintStage = {
  phase: 'ordinary-fix' | 'validation',
  status: 0 | 1,
  results: z.infer<typeof resultSchema>,
};

export const EFFECTS_RULE_ID = 'local-effects/contracts';

/**
 * Each phase gets fresh parser/config/module state. In particular, TypeScript
 * parser caches cannot describe source from before the previous phase's edits.
 * One process per phase, never per file. No shell, cache or ignored exit status.
 */
export function runLintStage({ root, files, phase, maxWarnings }: {
  root: string, files: readonly string[], phase: LintStage['phase'], maxWarnings: number,
}): LintStage {
  if (files.length === 0) throw new Error('Select at least one lint path.');
  const require = createRequire(import.meta.url);
  const executable = path.join(path.dirname(require.resolve('eslint/package.json')), 'bin/eslint.js');
  const flags: string[] = ['--format', 'json', `--max-warnings=${maxWarnings}`];
  switch (phase) {
  case 'ordinary-fix':
    // Defer precisely this project-wide diagnostic rule, not all lint failures.
    // The independent effects pass remains mandatory for relevant source.
    flags.push('--fix', '--rule', `${EFFECTS_RULE_ID}:off`);
    break;
  case 'validation': break;
  default: { const exhaustive: never = phase; throw new Error(String(exhaustive)); }
  }
  const child = spawnSync(process.execPath, [executable, ...flags, '--', ...files], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (child.error !== undefined || child.signal !== null || (child.status !== 0 && child.status !== 1)) {
    throw new Error(`ESLint ${phase} failed: ${child.error?.message ?? child.stderr ?? child.signal ?? child.status}`);
  }
  const results = resultSchema.parse(JSON.parse(child.stdout) as unknown);
  if (results.length === 0) throw new Error(`ESLint ${phase} produced no results.`);
  const errors = results.reduce((count, result) => count + result.errorCount, 0);
  const warnings = results.reduce((count, result) => count + result.warningCount, 0);
  const failed = errors > 0 || (maxWarnings >= 0 && warnings > maxWarnings);
  if (child.status === 0 && failed) throw new Error(`ESLint ${phase} returned inconsistent diagnostics.`);
  return { phase, status: child.status === 1 || failed ? 1 : 0, results };
}
