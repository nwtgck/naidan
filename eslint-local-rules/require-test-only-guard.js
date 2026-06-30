import {
  getGuardedTestOnlyExportPayload,
  GUARDED_TEST_ONLY_EXAMPLE,
  GUARDED_TEST_ONLY_NAMED_EXPORT_EXAMPLE,
  isInsideGuardedTestOnlyPayload,
  isTestOnlyExportIdentifierName,
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
      description: 'Require test-only object fields and prefixed exports to use compile-time test guards.',
    },
    messages: {
      invalidObjectProperty: `TEST_ONLY must use this guarded spread so production bundling can remove both the field and its value:\n\n${GUARDED_TEST_ONLY_EXAMPLE}`,
      invalidExport: `TEST_ONLY must be a direct top-level object export. TEST_ONLY_-prefixed exports must use a direct compile-time guard so production bundling can remove their values:\n\nexport const TEST_ONLY = {\n  // test API\n};\n\n${GUARDED_TEST_ONLY_NAMED_EXPORT_EXAMPLE}`,
    },
  },
  create(context) {
    if (isTestSupportFilename(context.filename)) {
      return {};
    }

    return {
      FunctionDeclaration(node) {
        if (node.id === null || !isTestOnlyExportIdentifierName(node.id)) {
          return;
        }

        context.report({
          node,
          messageId: 'invalidExport',
        });
      },
      ClassDeclaration(node) {
        if (node.id === null || !isTestOnlyExportIdentifierName(node.id)) {
          return;
        }

        context.report({
          node,
          messageId: 'invalidExport',
        });
      },
      TSEnumDeclaration(node) {
        if (!isTestOnlyExportIdentifierName(node.id)) {
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
          || !isTestOnlyExportIdentifierName(node.key)
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
          || !isTestOnlyExportIdentifierName(node.id)
        ) {
          return;
        }

        const payload = node.init === null
          ? undefined
          : getGuardedTestOnlyExportPayload(node.init);
        const validPayload = payload !== undefined
          && (
            node.id.name !== 'TEST_ONLY'
            || payload.type === 'ObjectExpression'
          );

        if (validPayload) {
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
