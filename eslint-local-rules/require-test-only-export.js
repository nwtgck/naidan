
function isTestOnlyPropertyName(node) {
  if (node.type === 'Identifier') {
    return node.name === 'TEST_ONLY';
  }
  if (node.type === 'Literal') {
    return node.value === 'TEST_ONLY';
  }
  return false;
}

function isNeverRecord(node) {
  if (node.type !== 'TSTypeReference') {
    return false;
  }
  if (node.typeName.type !== 'Identifier' || node.typeName.name !== 'Record') {
    return false;
  }
  const params = node.typeArguments?.params;
  if (!params || params.length !== 2) {
    return false;
  }
  return params[0]?.type === 'TSNeverKeyword' && params[1]?.type === 'TSNeverKeyword';
}

function isOpenEndedRecord(node) {
  if (node.type !== 'TSTypeReference') {
    return false;
  }
  if (node.typeName.type !== 'Identifier' || node.typeName.name !== 'Record') {
    return false;
  }
  const keyType = node.typeArguments?.params[0];
  if (!keyType) {
    return false;
  }

  switch (keyType.type) {
  case 'TSStringKeyword':
  case 'TSNumberKeyword':
  case 'TSSymbolKeyword':
  case 'TSAnyKeyword':
  case 'TSUnknownKeyword':
    return true;
  case 'TSTypeReference':
    return keyType.typeName.type === 'Identifier' && keyType.typeName.name === 'PropertyKey';
  default:
    return false;
  }
}

function hasOpenEndedIndexSignature(node) {
  if (node.type !== 'TSTypeLiteral') {
    return false;
  }

  return node.members.some((member) => {
    if (member.type !== 'TSIndexSignature') {
      return false;
    }

    return member.parameters.some((parameter) => {
      if (parameter.type !== 'Identifier') {
        return false;
      }
      const annotation = parameter.typeAnnotation?.typeAnnotation;
      if (!annotation) {
        return true;
      }

      switch (annotation.type) {
      case 'TSStringKeyword':
      case 'TSNumberKeyword':
      case 'TSSymbolKeyword':
      case 'TSAnyKeyword':
      case 'TSUnknownKeyword':
        return true;
      default:
        return false;
      }
    });
  });
}

export const rule = {
  meta: {
    type: 'problem',
    docs: {
      description: "Ensure useXxx composables return a strongly typed TEST_ONLY object for testing internals.",
    },
    fixable: 'code',
    messages: {
      missingTestOnly: "Composable '{{ name }}' must return a 'TEST_ONLY' object for testing purposes.",
      optionalTestOnly: 'TEST_ONLY must be a required property, not an optional one.',
      openEndedRecord: 'TEST_ONLY must not use open-ended key types like Record<string, ...>. Use an explicit object type or Record<never, never>.',
      openEndedIndexSignature: 'TEST_ONLY must not use string/number/symbol index signatures. Use explicit property names or Record<never, never>.',
    },
  },
  create(context) {
    return {
      TSPropertySignature(node) {
        if (!isTestOnlyPropertyName(node.key)) {
          return;
        }

        if (node.optional) {
          context.report({
            node,
            messageId: 'optionalTestOnly',
          });
        }

        const annotation = node.typeAnnotation?.typeAnnotation;
        if (!annotation) {
          return;
        }

        if (isNeverRecord(annotation)) {
          return;
        }

        if (isOpenEndedRecord(annotation)) {
          context.report({
            node: annotation,
            messageId: 'openEndedRecord',
          });
          return;
        }

        if (hasOpenEndedIndexSignature(annotation)) {
          context.report({
            node: annotation,
            messageId: 'openEndedIndexSignature',
          });
        }
      },
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
            isTestOnlyPropertyName(prop.key)
          );

          if (!hasTestOnly) {
            context.report({
              node: node.argument,
              messageId: 'missingTestOnly',
              data: { name },
              fix(fixer) {
                const obj = node.argument;
                const sourceCode = context.sourceCode;
                const commentLines = [
                  '// Export internal state and logic used only for testing here. Do not reference these in production logic.',
                  '// ESLint-required for useXxx return objects.',
                ];
                
                if (obj.properties.length > 0) {
                  const lastProperty = obj.properties[obj.properties.length - 1];
                  const tokenAfterLastProperty = sourceCode.getTokenAfter(lastProperty);
                  const hasTrailingComma = tokenAfterLastProperty && tokenAfterLastProperty.value === ',';
                  
                  // Detect indentation from the last property
                  const lineOfLastProperty = sourceCode.lines[lastProperty.loc.start.line - 1];
                  const indentationMatch = lineOfLastProperty.match(/^\s*/);
                  const indent = indentationMatch ? indentationMatch[0] : '    ';
                  
                  const target = hasTrailingComma ? tokenAfterLastProperty : lastProperty;
                  const indentedComment = commentLines.join(`\n${indent}  `);
                  const textToInsert = (hasTrailingComma ? '' : ',') + `\n${indent}TEST_ONLY: {\n${indent}  ${indentedComment}\n${indent}},`;
                  
                  return fixer.insertTextAfter(target, textToInsert);
                } else {
                  // Empty object {}
                  const lineOfReturn = sourceCode.lines[node.loc.start.line - 1];
                  const indentationMatch = lineOfReturn.match(/^\s*/);
                  const indent = indentationMatch ? indentationMatch[0] : '  ';
                  const innerIndent = indent + '  ';
                  const indentedComment = commentLines.join(`\n${innerIndent}  `);
                  
                  return fixer.replaceText(obj, `{\n${innerIndent}TEST_ONLY: {\n${innerIndent}  ${indentedComment}\n${innerIndent}},\n${indent}}`);
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
