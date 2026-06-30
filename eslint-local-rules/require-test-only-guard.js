import {
  GUARDED_TEST_ONLY_EXAMPLE,
  isInsideGuardedTestOnlyPayload,
  isTestOnlyPropertyName,
  isTestSupportFilename,
} from './test-only-guard.js';

function isDirectModuleTestOnlyObjectExport(node) {
  const declaration = node.parent;
  const exportDeclaration = declaration?.parent;

  return node.id.type === 'Identifier'
    && node.id.name === 'TEST_ONLY'
    && node.init?.type === 'ObjectExpression'
    && declaration?.type === 'VariableDeclaration'
    && declaration.kind === 'const'
    && declaration.declarations.length === 1
    && exportDeclaration?.type === 'ExportNamedDeclaration'
    && exportDeclaration.declaration === declaration
    && exportDeclaration.parent.type === 'Program';
}

export const rule = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Require test-only object fields to use compile-time test guards.',
    },
    messages: {
      invalidObjectProperty: `TEST_ONLY must use this guarded spread so production bundling can remove both the field and its value:\n\n${GUARDED_TEST_ONLY_EXAMPLE}`,
      invalidExport: `TEST_ONLY must be a direct top-level object export:\n\nexport const TEST_ONLY = {\n  // test API\n};`,
    },
  },
  create(context) {
    if (isTestSupportFilename(context.filename)) {
      return {};
    }

    return {
      FunctionDeclaration(node) {
        if (node.id === null || !isTestOnlyPropertyName(node.id)) {
          return;
        }

        context.report({
          node,
          messageId: 'invalidExport',
        });
      },
      ClassDeclaration(node) {
        if (node.id === null || !isTestOnlyPropertyName(node.id)) {
          return;
        }

        context.report({
          node,
          messageId: 'invalidExport',
        });
      },
      TSEnumDeclaration(node) {
        if (!isTestOnlyPropertyName(node.id)) {
          return;
        }

        context.report({
          node,
          messageId: 'invalidExport',
        });
      },
      Property(node) {
        if (
          node.parent.type !== 'ObjectExpression'
          || !isTestOnlyPropertyName(node.key)
          || isInsideGuardedTestOnlyPayload(node)
        ) {
          return;
        }

        context.report({
          node,
          messageId: 'invalidObjectProperty',
        });
      },
      VariableDeclarator(node) {
        if (isDirectModuleTestOnlyObjectExport(node)) {
          return;
        }

        if (
          node.id.type !== 'Identifier'
          || !isTestOnlyPropertyName(node.id)
        ) {
          return;
        }

        context.report({
          node: node.init ?? node,
          messageId: 'invalidExport',
        });
      },
    };
  },
};

export default {
  files: ['**/*.ts', '**/*.tsx', '**/*.vue'],
  plugins: {
    'local-rules-test-only-guard': {
      rules: {
        'require-test-only-guard': rule,
      },
    },
  },
  rules: {
    'local-rules-test-only-guard/require-test-only-guard': 'error',
  },
};
