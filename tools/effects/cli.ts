import { runEffectTidy } from './maintenance/tidy.ts';
import { reviewEffects } from './review.ts';
import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { parseEffectsConfig } from './config-schema.ts';
import { runEffects } from './index.ts';
import { resolveProjectPath } from './project.ts';
import { printEffect } from './contracts/effects.ts';

export async function main({ argv, root }: { argv: string[], root: string }): Promise<number> {
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
      },
    });
    const mode = args.positionals[0];
    if ((mode !== 'check' && mode !== 'fix' && mode !== 'tidy') || args.positionals.length !== 1) throw new Error('Usage: effects <check|fix|tidy> [--config effects.config.ts] [--file relative/path.ts] [--json] [--explain] [--write (tidy only)]');
    if (args.values.write !== undefined && mode !== 'tidy') throw new Error('--write is valid only for tidy; check never writes and fix is already explicit.');
    const configFile = resolveProjectPath({ root, relative: args.values.config ?? 'effects.config.ts' });
    const inputSnapshots = new Map([[configFile, fs.readFileSync(configFile, 'utf8')]]);
    const module: unknown = await import(pathToFileURL(configFile).href);
    if (typeof module !== 'object' || module === null || !('default' in module)) throw new Error('The effects configuration must have a default export.');
    const loaded = parseEffectsConfig({ value: module.default });
    // --file narrows inference, not validation, in tidy mode. Other enrolled
    // callers and dependencies retain their contracts and still get checked.
    const { result, maintenance } = (() => {
      switch (mode) {
      case 'check': case 'fix':
        return { result: runEffects({ root, config: args.values.file === undefined ? loaded : { ...loaded, files: args.values.file }, mode, inputSnapshots }), maintenance: undefined };
      case 'tidy': {
        const maintenance = runEffectTidy({
          root,
          config: loaded,
          files: args.values.file ?? loaded.files,
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
      console.log(JSON.stringify(report, undefined, 2));
    } else {
      if (maintenance !== undefined) {
        console.log(`Effect tidy ${args.values.write === true ? 'write' : 'preview (no files written)'}: ${maintenance.changes.length} contract changes, ${maintenance.edits.length} planned files.`);
        for (const change of maintenance.changes) {
          console.log(`  ${path.relative(root, change.file)}:${change.start} ${change.label}`);
          console.log(`    - ${change.before.join(', ') || 'none'}`);
          console.log(`    + ${change.after.join(', ') || 'none'}`);
        }
        console.log(`  Preserved ${maintenance.selections.filter(item => item.disposition === 'preserve').length} non-selected or slot/signature contracts. See --json for selection reasons.`);
      }
      for (const diagnostic of result.analysis.diagnostics) {
        const source = result.analysis.sources.get(path.resolve(diagnostic.file));
        const prefix = source === undefined ? '' : String(source.slice(0, diagnostic.start).split('\n').length) + ': ';
        console.error(`${path.relative(root, diagnostic.file)}:${prefix}[${diagnostic.code}] ${diagnostic.message}`);
        for (const related of diagnostic.related) console.error(`  ${path.relative(root, related.file)}:${related.start}: ${related.message}`);
      }
      for (const item of result.analysis.unsafeSuppressions) {
        console.log(`UNSAFE effect suppression: ${path.relative(root, item.file)}:${item.start} ${item.label}: ${item.suppressed.map(effect => printEffect({ effect })).join(', ')} -- ${item.reason}`);
      }
      if (review !== undefined) {
        console.log('Selected primitive policies (guards/diagnostics still apply):');
        for (const decision of result.analysis.modelDecisions) {
          console.log(`  ${path.relative(root, decision.file)}:${decision.start} ${decision.operation} [${decision.access}, ${decision.disposition}] => ${decision.effects.map(effect => printEffect({ effect })).join(', ') || 'none'}`);
          console.log(`    ${path.relative(root, decision.definitionFile)} [${decision.rule}]: ${decision.reason}`);
        }
        console.log('Effect contract review (dependency witnesses, not runtime traces):');
        for (const entry of review) {
          const file = path.relative(root, entry.file);
          console.log(`  ${file}:${entry.start} ${entry.label} [${entry.role}]`);
          console.log(`    declared: ${entry.declared.join(', ') || 'none'}; outward: ${entry.outward.join(', ') || 'none'}`);
          for (const witness of entry.witnesses) {
            console.log(`    ${witness.effect} [${witness.basis}]`);
            for (const step of witness.path) console.log(`      ${path.relative(root, step.file)}:${step.start} ${step.label}: ${step.reason}`);
          }
        }
      }
      console.log(`Effects: ${result.analysis.coverage.files.length} selected files, ${result.analysis.coverage.functions} functions, ${result.analysis.diagnostics.length} diagnostics, ${result.changedFiles.length} changed files, ${result.analysis.unsafeSuppressions.length} unsafe suppressions.`);
    }
    return result.analysis.diagnostics.length === 0 ? 0 : 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await main({ argv: process.argv.slice(2), root: process.cwd() });
}
