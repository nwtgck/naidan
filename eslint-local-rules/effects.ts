import path from 'node:path';
import type { Rule } from 'eslint';
import type ts from 'typescript';
import { analyzeEffects } from '../tools/effects/index.ts';
import { checkModelInputs } from '../tools/effects/project.ts';
import { assertEffectSnapshots } from '../tools/effects/fixes/apply.ts';
import type { EffectsAnalysis } from '../tools/effects/analysis/analyze.ts';
import type { EffectsConfig } from '../tools/effects/config.ts';

/** Parser services are supplied by typescript-eslint, not by user source text. */
function isTypeScriptProgram(value: unknown): value is ts.Program {
  return typeof value === 'object' && value !== null
    && 'getTypeChecker' in value && typeof value.getTypeChecker === 'function'
    && 'getSourceFiles' in value && typeof value.getSourceFiles === 'function';
}

export function createEffectsRule({ root, config }: { root: string, config: EffectsConfig }): Rule.RuleModule {
  // Program identity changes on editor updates. Never cache by path/mtime alone.
  const cache = new WeakMap<ts.Program, EffectsAnalysis>();
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
            let analysis = cache.get(program);
            if (analysis === undefined) {
              analysis = analyzeEffects({ program, root, config }); cache.set(program, analysis);
            }
            assertEffectSnapshots({ root, plan: { edits: [], snapshots: analysis.sources } });
            const source = program.getSourceFile(file);
            if (source === undefined || source.text !== context.sourceCode.text) {
              context.report({ node, messageId: 'configuration', data: { message: 'Effect analysis and editor text differ; refresh the typed lint Program before applying changes.' } });
              return;
            }
            for (const diagnostic of analysis.diagnostics) {
              // Dependency failures still fail a scoped lint even when only the caller was requested.
              const local = path.resolve(diagnostic.file) === file;
              const index = local ? Math.min(diagnostic.start, context.sourceCode.text.length) : 0;
              context.report({
                loc: context.sourceCode.getLocFromIndex(index),
                messageId: 'violation',
                data: {
                  message: `${local ? '' : `${path.relative(root, diagnostic.file)}: `}[${diagnostic.code}] ${diagnostic.message} Use effects:fix for project-wide contract updates.`,
                },
              });
            }
          } catch (error) {
            context.report({ node, messageId: 'configuration', data: { message: error instanceof Error ? error.message : String(error) } });
          }
        },
      };
    },
  };
}
