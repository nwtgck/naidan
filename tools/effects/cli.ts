import { UNVERIFIED_EFFECT_NOTE } from './maintenance/unverified.ts';
import { runEffectTidy } from './maintenance/tidy.ts';
import { reviewEffects } from './review.ts';
import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { parseEffectsConfig } from './config-schema.ts';
import { runEffects } from './index.ts';
import { resolveProjectPath, selectEffectEntries } from './project.ts';
import { printEffect } from './contracts/effects.ts';

export async function executeEffectsCommand({ argv, root }: { argv: string[], root: string }): Promise<{ exitCode: number, stdout: string, stderr: string }> {
  let stdout = '';
  let stderr = '';
  try {
    const args = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        config: { type: 'string' },
        explain: { type: 'boolean' },
        json: { type: 'boolean' },
        file: { type: 'string', multiple: true },
        write: { type: 'boolean' },
        'allow-unresolved': { type: 'boolean' },
      },
    });
    const mode = args.positionals[0];
    if ((mode !== 'check' && mode !== 'fix' && mode !== 'tidy') || args.positionals.length !== 1) throw new Error('Usage: effects <check|fix|tidy> [--config effects.config.ts] [--file relative/path.ts|relative/directory] [--json] [--explain] [--write (tidy only)] [--allow-unresolved (fix/tidy only)]');
    if (args.values.write !== undefined && mode !== 'tidy') throw new Error('--write is valid only for tidy; check never writes and fix is already explicit.');
    if (args.values['allow-unresolved'] === true && mode === 'check') throw new Error('--allow-unresolved is valid only for fix or tidy; check reports incomplete verification.');
    const configFile = resolveProjectPath({ root, relative: args.values.config ?? 'effects.config.ts' });
    const inputSnapshots = new Map([[configFile, fs.readFileSync(configFile, 'utf8')]]);
    const module: unknown = await import(pathToFileURL(configFile).href);
    if (typeof module !== 'object' || module === null || !('default' in module)) throw new Error('The effects configuration must have a default export.');
    const loaded = parseEffectsConfig({ value: module.default });
    const files = args.values.file === undefined ? undefined : selectEffectEntries({ root, config: loaded, files: args.values.file });
    const config = files === undefined ? loaded : { ...loaded, files };
    // Explicit entries select writes while all commands still analyze reached dependencies.
    // Without --file, fix preserves its whole-scope behavior and tidy selects configured entries.
    const { result, maintenance } = (() => {
      switch (mode) {
      case 'check': case 'fix':
        return { result: runEffects({ root, config, mode, inputSnapshots, files, ...(args.values['allow-unresolved'] === true ? { unresolved: { mode: 'fix' as const, write: 'write' as const } } : {}) }), maintenance: undefined };
      case 'tidy': {
        if (args.values['allow-unresolved'] === true) return {
          result: runEffects({ root, config, mode: 'fix', inputSnapshots, files: config.files, unresolved: { mode: 'tidy', write: args.values.write === true ? 'write' : 'preview' } }),
          maintenance: undefined,
        };
        const maintenance = runEffectTidy({
          root,
          config,
          files: config.files,
          write: args.values.write === true ? 'write' : 'preview',
          inputSnapshots,
        });
        return { result: maintenance, maintenance };
      }
      default: { const exhaustive: never = mode; throw new Error(String(exhaustive)); }
      }
    })();
    const review = args.values.explain === true ? reviewEffects({ analysis: result.analysis, budget: 10_000 }) : undefined;
    if (args.values.json === true) {
      const report = {
        scope: result.analysis.coverage,
        verification: args.values['allow-unresolved'] === true || result.analysis.diagnostics.some(item => item.message === UNVERIFIED_EFFECT_NOTE) ? 'unverified' : result.analysis.diagnostics.length === 0 ? 'verified' : 'failed',
        ...('unresolved' in result && result.unresolved !== undefined ? { unresolved: { ...result.unresolved, plannedFiles: result.unresolved.plannedFiles.map(file => path.relative(root, file)) } } : {}),
        ...(maintenance === undefined ? {} : {
          tidy: {
            mode: args.values.write === true ? 'write' : 'preview',
            changes: maintenance.changes.map(change => ({ ...change, file: path.relative(root, change.file) })),
            selections: maintenance.selections.map(selection => ({ ...selection, file: path.relative(root, selection.file) })),
            edits: maintenance.edits.map(edit => ({ ...edit, file: path.relative(root, edit.file) })),
          },
        }),
        ...(review === undefined ? {} : { review, modelDecisions: result.analysis.modelDecisions.map(item => ({ ...item, file: path.relative(root, item.file), definitionFile: path.relative(root, item.definitionFile), effects: item.effects.map(effect => printEffect({ effect })) })) }),
        diagnostics: result.analysis.diagnostics,
        assumptions: result.analysis.assumptions,
        changedFiles: result.changedFiles,
        unsafeSuppressions: result.analysis.unsafeSuppressions.map(item => {
          const { file, start, length, owner, label, reason, specified, body, suppressed, outward, ...rest } = item;
          rest satisfies Record<PropertyKey, never>;
          return {
            file: path.relative(root, file),
            start,
            length,
            owner,
            label,
            reason,
            specified: specified.map(effect => printEffect({ effect })),
            body: body.map(effect => printEffect({ effect })),
            suppressed: suppressed.map(effect => printEffect({ effect })),
            outward: outward.map(effect => printEffect({ effect })),
          };
        }),
        contracts: result.analysis.owners.map(owner => ({
          file: path.relative(root, owner.location.file),
          start: owner.location.start,
          role: owner.role,
          label: owner.label,
          effects: (result.analysis.solution.rows.get(owner.id) ?? []).map(effect => printEffect({ effect })),
        })),
      };
      stdout += JSON.stringify(report, undefined, 2) + '\n';
    } else {
      if ('unresolved' in result && result.unresolved !== undefined) stdout += `UNVERIFIED effect candidates: ${result.unresolved.write}; ${result.unresolved.plannedFiles.length} planned files. Unresolved bodies/paths may be omitted; writing completed does not mean verification passed.\n`;
      if (maintenance !== undefined) {
        stdout += `Effect tidy ${args.values.write === true ? 'write' : 'preview (no files written)'}: ${maintenance.changes.length} contract changes, ${maintenance.edits.length} planned files.` + '\n';
        for (const change of maintenance.changes) {
          let annotationSuffix: string;
          switch (change.annotation) {
          case 'remove': annotationSuffix = ' (annotation removed)'; break;
          case 'retain': annotationSuffix = ''; break;
          default: { const exhaustive: never = change.annotation; throw new Error(String(exhaustive)); }
          }
          stdout += `  ${path.relative(root, change.file)}:${change.start} ${change.label}${annotationSuffix}` + '\n';
          stdout += `    - ${change.before.join(', ') || 'none'}` + '\n';
          stdout += `    + ${change.after.join(', ') || 'none'}` + '\n';
        }
        stdout += `  Preserved ${maintenance.selections.filter(item => item.disposition === 'preserve').length} non-selected or slot/signature contracts. See --json for selection reasons.` + '\n';
      }
      for (const diagnostic of result.analysis.diagnostics) {
        const source = result.analysis.sources.get(path.resolve(diagnostic.file));
        const prefix = source === undefined ? '' : String(source.slice(0, diagnostic.start).split('\n').length) + ': ';
        stderr += `${path.relative(root, diagnostic.file)}:${prefix}[${diagnostic.code}] ${diagnostic.message}` + '\n';
        for (const related of diagnostic.related) stderr += `  ${path.relative(root, related.file)}:${related.start}: ${related.message}` + '\n';
      }
      for (const item of result.analysis.unsafeSuppressions) {
        stdout += `UNSAFE effect suppression: ${path.relative(root, item.file)}:${item.start} ${item.label}: ${item.suppressed.map(effect => printEffect({ effect })).join(', ')} -- ${item.reason}` + '\n';
      }
      if (review !== undefined) {
        stdout += 'Selected primitive policies (guards/diagnostics still apply):' + '\n';
        for (const decision of result.analysis.modelDecisions) {
          stdout += `  ${path.relative(root, decision.file)}:${decision.start} ${decision.operation} [${decision.access}, ${decision.disposition}] => ${decision.effects.map(effect => printEffect({ effect })).join(', ') || 'none'}` + '\n';
          stdout += `    ${path.relative(root, decision.definitionFile)} [${decision.rule}]: ${decision.reason}` + '\n';
        }
        stdout += 'Effect contract review (dependency witnesses, not runtime traces):' + '\n';
        for (const entry of review) {
          const file = path.relative(root, entry.file);
          stdout += `  ${file}:${entry.start} ${entry.label} [${entry.role}]` + '\n';
          stdout += `    declared: ${entry.declared.join(', ') || 'none'}; outward: ${entry.outward.join(', ') || 'none'}` + '\n';
          for (const witness of entry.witnesses) {
            stdout += `    ${witness.effect} [${witness.basis}]` + '\n';
            for (const step of witness.path) stdout += `      ${path.relative(root, step.file)}:${step.start} ${step.label}: ${step.reason}` + '\n';
          }
        }
      }
      stdout += `Effects: ${result.analysis.coverage.files.length} selected files, ${result.analysis.coverage.functions} functions, ${result.analysis.diagnostics.length} diagnostics, ${result.changedFiles.length} changed files, ${result.analysis.unsafeSuppressions.length} unsafe suppressions.` + '\n';
    }
    return { exitCode: args.values['allow-unresolved'] === true || result.analysis.diagnostics.length === 0 ? 0 : 1, stdout, stderr };
  } catch (error) {
    stderr += (error instanceof Error ? error.message : String(error)) + '\n';
    return { exitCode: 2, stdout, stderr };
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const result = await executeEffectsCommand({ argv: process.argv.slice(2), root: process.cwd() });
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exitCode = result.exitCode;
}
