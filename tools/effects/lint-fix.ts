import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { parseEffectsConfig } from './config-schema.ts';
import { runEffects } from './index.ts';
import { createEffectsProgram, resolveProjectPath } from './project.ts';
import { runLintStage, type LintStage } from './maintenance/lint-stages.ts';
import { printEffect } from './contracts/effects.ts';

function printStage({ stage, root }: { stage: LintStage, root: string }): void {
  for (const result of stage.results) {
    for (const message of result.messages) {
      console.error(`${path.relative(root, result.filePath)}:${message.line ?? 1}:${message.column ?? 1} [${message.ruleId ?? 'parse'}] ${message.message}`);
    }
  }
}

/**
 * Project-level orchestration, not side effects inside an ESLint rule.
 * Ordinary fixes may already be written when a later stage fails, exactly as
 * ordinary lint --fix can fix some errors while leaving others. Effect edits
 * themselves retain snapshot, projection and rollback checks.
 */
export async function main({ root, argv }: { root: string, argv: string[] }): Promise<number> {
  try {
    const args = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        'effects-config': { type: 'string' },
        'max-warnings': { type: 'string' },
        json: { type: 'boolean' },
      },
    });
    const files = args.positionals.length === 0 ? ['.'] : args.positionals;
    const maxWarnings = args.values['max-warnings'] === undefined ? -1 : Number(args.values['max-warnings']);
    if (!Number.isSafeInteger(maxWarnings) || maxWarnings < -1) throw new Error('--max-warnings must be -1 or a nonnegative integer.');
    const first = runLintStage({ root, files, phase: 'ordinary-fix', maxWarnings });
    if (first.status !== 0) {
      if (args.values.json === true) console.log(JSON.stringify({ stages: [first], effects: undefined, exitCode: first.status }));
      else {
        printStage({ stage: first, root }); console.error('Effect updates were not run because ordinary lint still fails. Ordinary fixes may already have been written.');
      }
      return first.status;
    }
    // Load configuration only after ordinary fixes, in this fresh tsx process.
    const configFile = resolveProjectPath({ root, relative: args.values['effects-config'] ?? 'effects.config.ts' });
    const inputSnapshots = new Map([[configFile, fs.readFileSync(configFile, 'utf8')]]);
    const module: unknown = await import(pathToFileURL(configFile).href);
    if (typeof module !== 'object' || module === null || !('default' in module)) throw new Error('The effects configuration must have a default export.');
    const config = parseEffectsConfig({ value: module.default });
    const program = createEffectsProgram({ root, config, overlays: new Map() });
    const analyzed = new Set(program.getSourceFiles().filter(source => !source.fileName.endsWith('.test.ts') && !program.isSourceFileFromExternalLibrary(source)).map(source => path.resolve(source.fileName)));
    const relevant = first.results.some(result => path.resolve(result.filePath) === configFile || analyzed.has(path.resolve(result.filePath)));
    // A change to a dependency can affect an enrolled caller. Use the complete
    // configured effects scope, not just files matched by the ordinary linter.
    const effects = relevant ? runEffects({ root, config, mode: 'fix', inputSnapshots }) : undefined;
    const validationFiles = new Set([
      ...first.results.map(result => result.filePath),
      ...(effects?.analysis.coverage.files ?? []),
      ...(effects?.changedFiles ?? []),
    ]);
    const last = runLintStage({ root, files: [...validationFiles], phase: 'validation', maxWarnings });
    if (args.values.json === true) {
      console.log(JSON.stringify({
        stages: [first, last],
        effects: effects === undefined ? { status: 'not-relevant' } : {
          status: 'checked',
          scope: effects.analysis.coverage,
          changedFiles: effects.changedFiles,
          diagnostics: effects.analysis.diagnostics,
          assumptions: effects.analysis.assumptions,
          unsafeSuppressions: effects.analysis.unsafeSuppressions,
        },
        exitCode: last.status,
      }, undefined, 2));
    } else {
      printStage({ stage: last, root });
      if (effects === undefined) console.log('Effects: no analyzed product files were selected; no contract updates.');
      else {
        for (const item of effects.analysis.unsafeSuppressions) console.log(`UNSAFE effect suppression: ${path.relative(root, item.file)}:${item.start} ${item.label}: ${item.suppressed.map(effect => printEffect({ effect })).join(', ')} -- ${item.reason}`);
        for (const file of effects.changedFiles) console.log(`Effect contract updated: ${path.relative(root, file)}`);
        console.log(`Effects: ${effects.analysis.coverage.files.length} files in the configured dependency scope; ${effects.changedFiles.length} changed files. Tidy is never implicit.`);
      }
      console.log(`Lint fix: ordinary fixes, scoped effect updates, final non-fixing validation (${last.status === 0 ? 'passed' : 'failed'}).`);
    }
    return last.status;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error('Lint fix stopped. Earlier ordinary fixes may already be on disk; no failure was ignored.');
    return 2;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await main({ root: process.cwd(), argv: process.argv.slice(2) });
}
