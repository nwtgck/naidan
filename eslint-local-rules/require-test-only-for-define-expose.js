import {
  containsTestOnlyProperty,
  GUARDED_TEST_ONLY_EXAMPLE,
  isGuardedTestOnlySpread,
} from './test-only-guard.js';

const COMMENT_LINES = [
  '// Export internal state and logic used only for testing here. Do not reference these in production logic.',
  '// ESLint-required for defineExpose.',
];

function createGuardedTestOnlyText({ indent }) {
  const comment = COMMENT_LINES.join(`\n${indent}    `);

  return `...((__BUILD_MODE_IS_TEST__ && {\n${indent}  TEST_ONLY: {\n${indent}    ${comment}\n${indent}  },\n${indent}}) || {})`;
}

export const rule = {
  meta: {
    type: 'suggestion',
    docs: {
      description: 'Ensure defineExpose includes a guarded TEST_ONLY object in .vue files.',
    },
    fixable: 'code',
    messages: {
      missingDefineExpose: `All .vue files must include a guarded TEST_ONLY exposure:\n\n${GUARDED_TEST_ONLY_EXAMPLE}`,
      missingTestOnly: `defineExpose must include this guarded TEST_ONLY spread:\n\n${GUARDED_TEST_ONLY_EXAMPLE}`,
      invalidTestOnlyGuard: `defineExpose TEST_ONLY must use this exact guarded spread:\n\n${GUARDED_TEST_ONLY_EXAMPLE}`,
    },
  },
  create(context) {
    if (!context.filename.endsWith('.vue')) {
      return {};
    }

    let defineExposeNode = null;

    return {
      CallExpression(node) {
        if (node.callee.type === 'Identifier' && node.callee.name === 'defineExpose') {
          defineExposeNode = node;
        }
      },
      'Program:exit'(node) {
        const sourceCode = context.sourceCode;

        if (defineExposeNode === null) {
          context.report({
            node,
            messageId: 'missingDefineExpose',
            fix(fixer) {
              const text = sourceCode.getText();
              const scriptSetupMatch = text.match(/<script\s+setup[^>]*>/);
              const guardedText = createGuardedTestOnlyText({ indent: '  ' });
              const defineExposeText = `\n\ndefineExpose({\n  ${guardedText},\n});\n`;

              if (scriptSetupMatch !== null) {
                const endOfScriptSetup = text.indexOf('</script>', scriptSetupMatch.index);
                if (endOfScriptSetup !== -1) {
                  return fixer.insertTextBeforeRange(
                    [endOfScriptSetup, endOfScriptSetup],
                    defineExposeText,
                  );
                }
              }

              const newScriptSetup = `<script setup lang="ts">\ndefineExpose({\n  ${guardedText},\n});\n</script>\n\n`;
              const templateMatch = text.match(/<template>/);

              if (templateMatch !== null) {
                return fixer.insertTextBeforeRange(
                  [templateMatch.index, templateMatch.index],
                  newScriptSetup,
                );
              }

              return fixer.insertTextBeforeRange([0, 0], newScriptSetup);
            },
          });
          return;
        }

        const argument = defineExposeNode.arguments[0];
        if (argument === undefined || argument.type !== 'ObjectExpression') {
          context.report({
            node: defineExposeNode,
            messageId: 'missingTestOnly',
          });
          return;
        }

        if (argument.properties.some(isGuardedTestOnlySpread)) {
          return;
        }

        if (containsTestOnlyProperty(argument)) {
          context.report({
            node: argument,
            messageId: 'invalidTestOnlyGuard',
          });
          return;
        }

        context.report({
          node: argument,
          messageId: 'missingTestOnly',
          fix(fixer) {
            const line = sourceCode.lines[argument.loc.start.line - 1];
            const indent = line.match(/^\s*/)?.[0] ?? '';
            const propertyIndent = `${indent}  `;
            const guardedText = createGuardedTestOnlyText({ indent: propertyIndent });

            if (argument.properties.length === 0) {
              return fixer.replaceText(
                argument,
                `{\n${propertyIndent}${guardedText},\n${indent}}`,
              );
            }

            const lastProperty = argument.properties.at(-1);
            const tokenAfterLastProperty = sourceCode.getTokenAfter(lastProperty);
            const hasTrailingComma = tokenAfterLastProperty?.value === ',';
            const target = hasTrailingComma ? tokenAfterLastProperty : lastProperty;

            return fixer.insertTextAfter(
              target,
              `${hasTrailingComma ? '' : ','}\n${propertyIndent}${guardedText},`,
            );
          },
        });
      },
    };
  },
};

export default {
  files: ['**/*.vue'],
  plugins: {
    'local-rules-define-expose': {
      rules: {
        'require-test-only-for-define-expose': rule,
      },
    },
  },
  rules: {
    'local-rules-define-expose/require-test-only-for-define-expose': 'error',
  },
};
