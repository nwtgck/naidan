
export const rule = {
  meta: {
    type: 'suggestion',
    docs: {
      description: "Ensure useXxx composables return a __testOnly object for testing internals.",
    },
    fixable: 'code',
    messages: {
      missingTestOnly: "Composable '{{ name }}' must return a '__testOnly' object for testing purposes.",
    },
  },
  create(context) {
    return {
      ReturnStatement(node) {
        // Get the function scope we are currently in
        let scope = context.sourceCode.getScope(node);
        while (scope && scope.type !== 'function') {
          scope = scope.upper;
        }

        if (!scope || !scope.block) return;

        const block = scope.block;
        let name = '';

        if (block.type === 'FunctionDeclaration' && block.id) {
          name = block.id.name;
        } else if (block.type === 'ArrowFunctionExpression' || block.type === 'FunctionExpression') {
          let parent = block.parent;
          // Skip ExportNamedDeclaration or other wrappers if necessary
          if (parent.type === 'ExportNamedDeclaration' && parent.declaration) {
            parent = parent.declaration;
          }
          
          if (parent.type === 'VariableDeclarator' && parent.id.type === 'Identifier') {
            name = parent.id.name;
          } else if (parent.type === 'AssignmentExpression' && parent.left.type === 'Identifier') {
            name = parent.left.name;
          } else if (parent.type === 'Property' && parent.key.type === 'Identifier') {
            name = parent.key.name;
          }
        }

        // Only match useXxx where X is uppercase
        if (!name || !/^use[A-Z]/.test(name)) {
          return;
        }

        // Only check if it returns an object literal
        if (node.argument && node.argument.type === 'ObjectExpression') {
          const hasTestOnly = node.argument.properties.some(prop => 
            (prop.type === 'Property' || prop.type === 'MethodDefinition') &&
            ((prop.key.type === 'Identifier' && prop.key.name === '__testOnly') ||
             (prop.key.type === 'Literal' && prop.key.value === '__testOnly'))
          );

          if (!hasTestOnly) {
            context.report({
              node: node.argument,
              messageId: 'missingTestOnly',
              data: { name },
              fix(fixer) {
                const obj = node.argument;
                const sourceCode = context.sourceCode;
                const comment = '// Export internal state and logic used only for testing here. Do not reference these in production logic.';
                
                if (obj.properties.length > 0) {
                  const lastProperty = obj.properties[obj.properties.length - 1];
                  const tokenAfterLastProperty = sourceCode.getTokenAfter(lastProperty);
                  const hasTrailingComma = tokenAfterLastProperty && tokenAfterLastProperty.value === ',';
                  
                  // Detect indentation from the last property
                  const lineOfLastProperty = sourceCode.lines[lastProperty.loc.start.line - 1];
                  const indentationMatch = lineOfLastProperty.match(/^\s*/);
                  const indent = indentationMatch ? indentationMatch[0] : '    ';
                  
                  const target = hasTrailingComma ? tokenAfterLastProperty : lastProperty;
                  const textToInsert = (hasTrailingComma ? '' : ',') + `\n${indent}__testOnly: {\n${indent}  ${comment}\n${indent}},`;
                  
                  return fixer.insertTextAfter(target, textToInsert);
                } else {
                  // Empty object {}
                  const lineOfReturn = sourceCode.lines[node.loc.start.line - 1];
                  const indentationMatch = lineOfReturn.match(/^\s*/);
                  const indent = indentationMatch ? indentationMatch[0] : '  ';
                  const innerIndent = indent + '  ';
                  
                  return fixer.replaceText(obj, `{\n${innerIndent}__testOnly: {\n${innerIndent}  ${comment}\n${innerIndent}},\n${indent}}`);
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
  files: ['**/*.ts', '**/*.vue'],
  plugins: {
    'local-rules-test-only': {
      rules: {
        'require-test-only-export': rule
      }
    }
  },
  rules: {
    'local-rules-test-only/require-test-only-export': 'error'
  }
};
