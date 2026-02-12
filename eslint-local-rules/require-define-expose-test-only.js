export const rule = {
  meta: {
    type: 'suggestion',
    docs: {
      description: "Ensure defineExpose is called with a __testOnly object in .vue files.",
    },
    fixable: 'code',
    messages: {
      missingDefineExpose: "All .vue files must include: defineExpose({ __testOnly: { /* internal state for testing */ } });",
      missingTestOnly: "defineExpose must include: __testOnly: { /* internal state for testing */ }",
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
        const comment = '// Export internal state and logic used only for testing here. Do not reference these in production logic.';
        
        if (!defineExposeNode) {
          context.report({
            node,
            messageId: 'missingDefineExpose',
            fix(fixer) {
              const sourceCode = context.sourceCode;
              const text = sourceCode.getText();
              
              // Check for <script setup>
              const scriptSetupMatch = text.match(/<script\s+setup[^>]*>/);
              const defineExposeText = `\n\ndefineExpose({\n  __testOnly: {\n    ${comment}\n  }\n});\n`;

              if (scriptSetupMatch) {
                // <script setup> exists but no defineExpose
                const endOfScriptSetup = text.indexOf('</script>', scriptSetupMatch.index);
                if (endOfScriptSetup !== -1) {
                  return fixer.insertTextBeforeRange([endOfScriptSetup, endOfScriptSetup], defineExposeText);
                }
              }

              // No <script setup> at all
              const newScriptSetup = `<script setup lang="ts">\ndefineExpose({\n  __testOnly: {\n    ${comment}\n  }\n});\n</script>\n\n`;
              
              // Try to insert before <template> or at the beginning of the file
              const templateMatch = text.match(/<template>/);
              if (templateMatch) {
                return fixer.insertTextBeforeRange([templateMatch.index, templateMatch.index], newScriptSetup);
              }
              
              return fixer.insertTextBeforeRange([0, 0], newScriptSetup);
            }
          });
        } else {
          const arg = defineExposeNode.arguments[0];
          if (!arg || arg.type !== 'ObjectExpression') {
            context.report({
              node: defineExposeNode,
              messageId: 'missingTestOnly',
              fix(fixer) {
                const text = `{\n  __testOnly: {\n    ${comment}\n  }\n}`;
                if (!arg) {
                  const openingParen = context.sourceCode.getTokenAfter(context.sourceCode.getFirstToken(defineExposeNode));
                  return fixer.insertTextAfter(openingParen, text);
                }
                return fixer.replaceText(arg, text);
              }
            });
            return;
          }

          const hasTestOnly = arg.properties.some(prop => 
            (prop.type === 'Property' || prop.type === 'MethodDefinition') &&
            ((prop.key.type === 'Identifier' && prop.key.name === '__testOnly') ||
             (prop.key.type === 'Literal' && prop.key.value === '__testOnly'))
          );

          if (!hasTestOnly) {
            context.report({
              node: arg,
              messageId: 'missingTestOnly',
              fix(fixer) {
                const sourceCode = context.sourceCode;
                
                if (arg.properties.length > 0) {
                  const lastProperty = arg.properties[arg.properties.length - 1];
                  const tokenAfterLastProperty = sourceCode.getTokenAfter(lastProperty);
                  const hasTrailingComma = tokenAfterLastProperty && tokenAfterLastProperty.value === ',';
                  
                  const lineOfLastProperty = sourceCode.lines[lastProperty.loc.start.line - 1];
                  const indentationMatch = lineOfLastProperty.match(/^\s*/);
                  const indent = indentationMatch ? indentationMatch[0] : '  ';
                  
                  const target = hasTrailingComma ? tokenAfterLastProperty : lastProperty;
                  const textToInsert = (hasTrailingComma ? '' : ',') + `\n${indent}__testOnly: {\n${indent}  ${comment}\n${indent}},`;
                  
                  return fixer.insertTextAfter(target, textToInsert);
                } else {
                  const lineOfDefineExpose = sourceCode.lines[defineExposeNode.loc.start.line - 1];
                  const indentationMatch = lineOfDefineExpose.match(/^\s*/);
                  const indent = indentationMatch ? indentationMatch[0] : '';
                  const innerIndent = indent + '  ';
                  
                  return fixer.replaceText(arg, `{\n${innerIndent}__testOnly: {\n${innerIndent}  ${comment}\n${innerIndent}},\n${indent}}`);
                }
              }
            });
          }
        }
      }
    };
  }
};

export default {
  files: ['**/*.vue'],
  plugins: {
    'local-rules-define-expose': {
      rules: {
        'require-define-expose-test-only': rule
      }
    }
  },
  rules: {
    'local-rules-define-expose/require-define-expose-test-only': 'error'
  }
};
