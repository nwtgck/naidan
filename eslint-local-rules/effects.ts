import path from 'node:path';
import type { Rule } from 'eslint';
import type ts from 'typescript';
import { analyzeEffects } from '../tools/effects/index.ts';
import { checkModelInputs } from '../tools/effects/project.ts';
import { assertEffectSnapshots } from '../tools/effects/fixes/apply.ts';
import type { EffectsConfig } from '../tools/effects/config.ts';
import type { EffectDiagnostic } from '../tools/effects/diagnostics.ts';

/** Parser services are supplied by typescript-eslint, not by user source text. */
function isTypeScriptProgram(value: unknown): value is ts.Program {
  return typeof value === 'object' && value !== null
    && 'getTypeChecker' in value && typeof value.getTypeChecker === 'function'
    && 'getSourceFiles' in value && typeof value.getSourceFiles === 'function';
}

export function createEffectsRule({ root, config }: { root: string, config: EffectsConfig }): Rule.RuleModule {
  // Program identity changes on editor updates. Never cache by path/mtime alone.
  const cache = new WeakMap<ts.Program, { sources: ReadonlyMap<string, string>, diagnosticsByFile: ReadonlyMap<string, readonly EffectDiagnostic[]>, foreignSummary: string | undefined }>();
  const selected = new Set(config.files.map(file => path.resolve(root, file)));
  return {
    meta: {
      type: 'problem',
      docs: { description: 'Check scoped, transitive operation contracts with the shared effects analyzer.' },
      schema: [],
      messages: { violation: '{{message}}', configuration: '{{message}}' },
    },
    create(context) {
      const file = path.resolve(context.filename);
      if (!selected.has(file) || file.endsWith('.test.ts')) return {};
      return {
        'Program:exit'(node) {
          const program: unknown = context.sourceCode.parserServices?.program;
          if (!isTypeScriptProgram(program)) {
            context.report({ node, messageId: 'configuration', data: { message: 'The effects rule requires a typescript-eslint Program.' } });
            return;
          }
          try {
            checkModelInputs({ root, config });
            let cached = cache.get(program);
            if (cached === undefined) {
              const analysis = analyzeEffects({ program, root, config });
              assertEffectSnapshots({ root, plan: { edits: [], snapshots: analysis.sources } });
              const diagnosticsByFile = new Map<string, EffectDiagnostic[]>();
              let foreignCount = 0;
              let firstForeign: EffectDiagnostic | undefined;
              for (const diagnostic of analysis.diagnostics) {
                const target = path.resolve(diagnostic.file);
                if (diagnostic.file !== '' && selected.has(target)) {
                  const diagnostics = diagnosticsByFile.get(target) ?? [];
                  diagnostics.push(diagnostic);
                  diagnosticsByFile.set(target, diagnostics);
                } else {
                  foreignCount++;
                  firstForeign ??= diagnostic;
                }
              }
              const origin = firstForeign?.file === '' ? '<project>' : firstForeign === undefined ? '' : path.relative(root, firstForeign.file);
              const foreignSummary = firstForeign === undefined ? undefined
                : `${foreignCount} effect diagnostics outside the configured entries. First: ${origin}: [${firstForeign.code}] ${firstForeign.message} Use effects:check for complete dependency diagnostics.`;
              cached = { sources: analysis.sources, diagnosticsByFile, foreignSummary };
              cache.set(program, cached);
            }
            const source = program.getSourceFile(file);
            if (source === undefined || source.text !== context.sourceCode.text || cached.sources.get(file) !== context.sourceCode.text) {
              context.report({ node, messageId: 'configuration', data: { message: 'Effect analysis and editor text differ; refresh the typed lint Program before applying changes.' } });
              return;
            }
            for (const diagnostic of cached.diagnosticsByFile.get(file) ?? []) {
              context.report({
                loc: context.sourceCode.getLocFromIndex(Math.min(diagnostic.start, context.sourceCode.text.length)),
                messageId: 'violation',
                data: { message: `[${diagnostic.code}] ${diagnostic.message} Use effects:fix for project-wide contract updates.` },
              });
            }
            // Keep dependency-only failures visible on every invocation, including cached Programs.
            if (cached.foreignSummary !== undefined) context.report({ node, messageId: 'violation', data: { message: cached.foreignSummary } });
          } catch (error) {
            context.report({ node, messageId: 'configuration', data: { message: error instanceof Error ? error.message : String(error) } });
          }
        },
      };
    },
  };
}
