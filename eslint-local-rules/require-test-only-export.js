import {
  containsTestOnlyProperty,
  GUARDED_TEST_ONLY_EXAMPLE,
  isGuardedTestOnlySpread,
  isTestOnlyPropertyName,
} from './test-only-guard.js';

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

function getFunctionName({ node, context }) {
  let scope = context.sourceCode.getScope(node);
  while (scope && scope.type !== 'function') {
    scope = scope.upper;
  }

  if (!scope || !scope.block) {
    return undefined;
  }

  const block = scope.block;
  if (block.type === 'FunctionDeclaration' && block.id) {
    return block.id.name;
  }

  if (block.type !== 'ArrowFunctionExpression' && block.type !== 'FunctionExpression') {
    return undefined;
  }

  let parent = block.parent;
  if (parent.type === 'ExportNamedDeclaration' && parent.declaration) {
    parent = parent.declaration;
  }

  if (parent.type === 'VariableDeclarator' && parent.id.type === 'Identifier') {
    return parent.id.name;
  }
  if (parent.type === 'AssignmentExpression' && parent.left.type === 'Identifier') {
    return parent.left.name;
  }
  if (parent.type === 'Property' && parent.key.type === 'Identifier') {
    return parent.key.name;
  }

  return undefined;
}

function createGuardedTestOnlyText({ indent }) {
  const commentLines = [
    '// Export internal state and logic used only for testing here. Do not reference these in production logic.',
    '// ESLint-required for useXxx return objects.',
  ];
  const comment = commentLines.join(`\n${indent}    `);

  return `...((__BUILD_MODE_IS_TEST__ && {\n${indent}  TEST_ONLY: {\n${indent}    ${comment}\n${indent}  },\n${indent}}) || {})`;
}

export const rule = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Ensure useXxx composables return a strongly typed guarded TEST_ONLY object.',
    },
    fixable: 'code',
    messages: {
      missingTestOnly: `Composable '{{ name }}' must return this guarded TEST_ONLY spread:\n\n${GUARDED_TEST_ONLY_EXAMPLE}`,
      invalidTestOnlyGuard: `Composable '{{ name }}' must use this exact guarded TEST_ONLY spread:\n\n${GUARDED_TEST_ONLY_EXAMPLE}`,
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
        if (!annotation || isNeverRecord(annotation)) {
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
        const name = getFunctionName({ node, context });
        if (!name || !/^use[A-Z]/.test(name)) {
          return;
        }

        if (!node.argument || node.argument.type !== 'ObjectExpression') {
          return;
        }

        if (node.argument.properties.some(isGuardedTestOnlySpread)) {
          return;
        }

        if (containsTestOnlyProperty(node.argument)) {
          context.report({
            node: node.argument,
            messageId: 'invalidTestOnlyGuard',
            data: { name },
          });
          return;
        }

        context.report({
          node: node.argument,
          messageId: 'missingTestOnly',
          data: { name },
          fix(fixer) {
            const sourceCode = context.sourceCode;
            const objectExpression = node.argument;
            const returnLine = sourceCode.lines[node.loc.start.line - 1];
            const returnIndent = returnLine.match(/^\s*/)?.[0] ?? '';
            const propertyIndent = `${returnIndent}  `;
            const guardedText = createGuardedTestOnlyText({ indent: propertyIndent });

            if (objectExpression.properties.length === 0) {
              return fixer.replaceText(
                objectExpression,
                `{\n${propertyIndent}${guardedText},\n${returnIndent}}`,
              );
            }

            const lastProperty = objectExpression.properties.at(-1);
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
  files: ['**/*.ts', '**/*.vue'],
  plugins: {
    'local-rules-test-only': {
      rules: {
        'require-test-only-export': rule,
      },
    },
  },
  rules: {
    'local-rules-test-only/require-test-only-export': 'error',
  },
};
