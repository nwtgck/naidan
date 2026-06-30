const requiredExportLines = [
  '// Export internal state and logic used only for testing here. Do not reference these in production logic.',
  '// ESLint-required for TypeScript modules.',
  'export const TEST_ONLY = {};',
];

function isTestOnlyIdentifier(node) {
  return node?.type === 'Identifier' && node.name === 'TEST_ONLY';
}

function bindingContainsTestOnly({ node }) {
  if (isTestOnlyIdentifier(node)) {
    return true;
  }

  if (node?.type === 'ObjectPattern') {
    return node.properties.some((property) => (
      property.type === 'RestElement'
        ? bindingContainsTestOnly({ node: property.argument })
        : bindingContainsTestOnly({ node: property.value })
    ));
  }

  if (node?.type === 'ArrayPattern') {
    return node.elements.some((element) => (
      element !== null && bindingContainsTestOnly({ node: element })
    ));
  }

  if (node?.type === 'AssignmentPattern') {
    return bindingContainsTestOnly({ node: node.left });
  }

  if (node?.type === 'RestElement') {
    return bindingContainsTestOnly({ node: node.argument });
  }

  return false;
}

function expressionReferencesTestOnly({ node }) {
  if (isTestOnlyIdentifier(node)) {
    return true;
  }

  switch (node?.type) {
  case 'ChainExpression':
  case 'TSAsExpression':
  case 'TSInstantiationExpression':
  case 'TSNonNullExpression':
  case 'TSSatisfiesExpression':
  case 'TSTypeAssertion':
    return expressionReferencesTestOnly({ node: node.expression });
  default:
    return false;
  }
}

function getDeclaredTestOnlyIdentifiers({ statement }) {
  if (statement.type === 'VariableDeclaration') {
    return statement.declarations.filter((declaration) => bindingContainsTestOnly({ node: declaration.id }));
  }

  if (
    statement.type === 'FunctionDeclaration'
    || statement.type === 'ClassDeclaration'
    || statement.type === 'TSTypeAliasDeclaration'
    || statement.type === 'TSInterfaceDeclaration'
    || statement.type === 'TSEnumDeclaration'
    || statement.type === 'TSModuleDeclaration'
    || statement.type === 'TSDeclareFunction'
  ) {
    return isTestOnlyIdentifier(statement.id) ? [statement] : [];
  }

  return [];
}

function getTopLevelTestOnlyEntries({ statement }) {
  if (statement.type === 'ImportDeclaration') {
    return statement.specifiers.filter((specifier) => isTestOnlyIdentifier(specifier.local));
  }

  if (statement.type === 'ExportNamedDeclaration') {
    const entries = statement.specifiers.filter((specifier) => (
      isTestOnlyIdentifier(specifier.local)
      || isTestOnlyIdentifier(specifier.exported)
    ));

    if (statement.declaration !== null) {
      entries.push(...getDeclaredTestOnlyIdentifiers({ statement: statement.declaration }));
    }

    return entries;
  }

  if (statement.type === 'ExportDefaultDeclaration') {
    const declaredEntries = getDeclaredTestOnlyIdentifiers({ statement: statement.declaration });
    if (declaredEntries.length > 0) {
      return declaredEntries;
    }

    return expressionReferencesTestOnly({ node: statement.declaration }) ? [statement] : [];
  }

  if (statement.type === 'ExportAllDeclaration') {
    return isTestOnlyIdentifier(statement.exported) ? [statement] : [];
  }

  if (statement.type === 'TSExportAssignment') {
    return expressionReferencesTestOnly({ node: statement.expression }) ? [statement] : [];
  }

  if (statement.type === 'TSImportEqualsDeclaration') {
    return isTestOnlyIdentifier(statement.id) ? [statement] : [];
  }

  return getDeclaredTestOnlyIdentifiers({ statement });
}

function isValidTestOnlyExport({ statement }) {
  if (
    statement.type !== 'ExportNamedDeclaration'
    || statement.declaration?.type !== 'VariableDeclaration'
    || statement.declaration.declare === true
    || statement.declaration.kind !== 'const'
    || statement.declaration.declarations.length !== 1
  ) {
    return false;
  }

  const [declaration] = statement.declaration.declarations;
  return isTestOnlyIdentifier(declaration?.id)
    && declaration.init?.type === 'ObjectExpression';
}

function getLineEnding({ text }) {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

function buildMissingExportInsertion(sourceCode) {
  const text = sourceCode.getText();
  const lineEnding = getLineEnding({ text });
  const requiredExport = `${requiredExportLines.join(lineEnding)}${lineEnding}`;

  if (text.length === 0 || text.endsWith(`${lineEnding}${lineEnding}`)) {
    return requiredExport;
  }
  if (text.endsWith(lineEnding)) {
    return `${lineEnding}${requiredExport}`;
  }
  return `${lineEnding}${lineEnding}${requiredExport}`;
}

function getTestOnlyVariables(sourceCode) {
  return sourceCode.scopeManager.scopes.flatMap((scope) => (
    scope.variables.filter((variable) => variable.name === 'TEST_ONLY')
  ));
}

function hasUnresolvedTestOnlyReference(sourceCode) {
  return sourceCode.scopeManager.globalScope?.through.some((reference) => (
    isTestOnlyIdentifier(reference.identifier)
  )) === true;
}

export const rule = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Require a removable top-level TEST_ONLY object export in testable TypeScript modules.',
    },
    fixable: 'code',
    schema: [],
    messages: {
      missing: `\
This TypeScript module must export test-only access from a top-level object literal.

export const TEST_ONLY = {};`,
      invalid: `\
TEST_ONLY must be declared exactly once as a top-level exported const initialized directly with an object literal.

export const TEST_ONLY = {
  // test API
};`,
      duplicate: 'This TypeScript module must contain exactly one top-level TEST_ONLY declaration.',
    },
  },
  create(context) {
    return {
      'Program:exit'(program) {
        const statementsWithTestOnly = program.body.filter((statement) => (
          getTopLevelTestOnlyEntries({ statement }).length > 0
        ));
        const validExports = program.body.filter((statement) => isValidTestOnlyExport({ statement }));
        const testOnlyVariables = getTestOnlyVariables(context.sourceCode);
        const hasUnresolvedReference = hasUnresolvedTestOnlyReference(context.sourceCode);
        const hasAnyTestOnly = statementsWithTestOnly.length > 0
          || testOnlyVariables.length > 0
          || hasUnresolvedReference;

        if (!hasAnyTestOnly) {
          context.report({
            node: program,
            messageId: 'missing',
            fix(fixer) {
              return fixer.insertTextAfterRange(
                [0, context.sourceCode.getText().length],
                buildMissingExportInsertion(context.sourceCode),
              );
            },
          });
          return;
        }

        const isValid = statementsWithTestOnly.length === 1
          && validExports.length === 1
          && testOnlyVariables.length === 1
          && !hasUnresolvedReference;
        if (isValid) {
          return;
        }

        const isDuplicate = validExports.length === 1
          && (statementsWithTestOnly.length > 1 || testOnlyVariables.length > 1);
        context.report({
          node: statementsWithTestOnly[0] ?? program,
          messageId: isDuplicate ? 'duplicate' : 'invalid',
        });
      },
    };
  },
};

export default {
  files: ['src/**/*.ts'],
  ignores: [
    'src/**/*.d.ts',
    'src/**/*.test.ts',
    'src/**/*.spec.ts',
    'src/FailedOnlyReporter.ts',
    'src/test-mocks/**',
    'src/test-setup.ts',
    'src/test-tmp/**',
    'src/strings/catalogs/**',
    'src/strings/messages/**',
  ],
  plugins: {
    'local-rules-module-test-only': {
      rules: {
        'require-test-only-for-module-export': rule,
      },
    },
  },
  rules: {
    'local-rules-module-test-only/require-test-only-for-module-export': 'error',
  },
};
