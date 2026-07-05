// Keep TEST_ONLY multiline so newly added test-only exports naturally remain one per line.
const requiredExportLines = [
  '// Export internal state and logic used only for testing here. Do not reference these in production logic.',
  '// ESLint-required for TypeScript modules.',
  'export const TEST_ONLY = {',
  '};',
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

function getTestOnlyObjectExpression({ statement }) {
  if (
    statement.type !== 'ExportNamedDeclaration'
    || statement.declaration?.type !== 'VariableDeclaration'
    || statement.declaration.declare === true
    || statement.declaration.kind !== 'const'
    || statement.declaration.declarations.length !== 1
  ) {
    return undefined;
  }

  const [declaration] = statement.declaration.declarations;
  if (
    !isTestOnlyIdentifier(declaration?.id)
    || declaration.init?.type !== 'ObjectExpression'
  ) {
    return undefined;
  }

  return declaration.init;
}

function isValidTestOnlyExport({ statement }) {
  return getTestOnlyObjectExpression({ statement }) !== undefined;
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

function isFinalStatement({ program, statement, sourceCode }) {
  if (program.body.at(-1) !== statement) {
    return false;
  }

  return sourceCode.getText().slice(statement.range[1]).trim().length === 0;
}

function isMultilineObjectExpression({ objectExpression }) {
  if (objectExpression.loc.start.line === objectExpression.loc.end.line) {
    return false;
  }

  let previousEndLine = objectExpression.loc.start.line;
  for (const property of objectExpression.properties) {
    if (property.loc.start.line <= previousEndLine) {
      return false;
    }
    previousEndLine = property.loc.end.line;
  }

  return objectExpression.loc.end.line > previousEndLine;
}

function hasCommentInside({ sourceCode, objectExpression }) {
  return sourceCode.getAllComments().some((comment) => (
    comment.range[0] > objectExpression.range[0]
    && comment.range[1] < objectExpression.range[1]
  ));
}

function buildMultilineObjectReplacement({ sourceCode, objectExpression }) {
  if (
    hasCommentInside({ sourceCode, objectExpression })
    || objectExpression.properties.some((property) => (
      property.loc.start.line !== property.loc.end.line
    ))
  ) {
    return undefined;
  }

  const lineEnding = getLineEnding({ text: sourceCode.getText() });
  if (objectExpression.properties.length === 0) {
    return `{${lineEnding}}`;
  }

  const propertyLines = objectExpression.properties.map((property) => (
    `  ${sourceCode.getText(property)},`
  ));
  return `{${lineEnding}${propertyLines.join(lineEnding)}${lineEnding}}`;
}

export const rule = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Require a removable final top-level multiline TEST_ONLY object export in testable TypeScript modules.',
    },
    fixable: 'code',
    schema: [],
    messages: {
      missing: `\
This TypeScript module must end with test-only access exported from a multiline top-level object literal.

export const TEST_ONLY = {
};`,
      invalid: `\
TEST_ONLY must be declared exactly once as a top-level exported const initialized directly with an object literal.

export const TEST_ONLY = {
  // test API
};`,
      duplicate: 'This TypeScript module must contain exactly one top-level TEST_ONLY declaration.',
      notLast: 'TEST_ONLY must be the final statement in the TypeScript module, with no comment or code after it.',
      singleLine: 'TEST_ONLY must use a multiline object literal with each exported test entry on its own line.',
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

        const isStructurallyValid = statementsWithTestOnly.length === 1
          && validExports.length === 1
          && testOnlyVariables.length === 1
          && !hasUnresolvedReference;
        if (!isStructurallyValid) {
          const isDuplicate = validExports.length === 1
            && (statementsWithTestOnly.length > 1 || testOnlyVariables.length > 1);
          context.report({
            node: statementsWithTestOnly[0] ?? program,
            messageId: isDuplicate ? 'duplicate' : 'invalid',
          });
          return;
        }

        const [validExport] = validExports;
        if (!isFinalStatement({
          program,
          statement: validExport,
          sourceCode: context.sourceCode,
        })) {
          context.report({
            node: validExport,
            messageId: 'notLast',
          });
          return;
        }

        const objectExpression = getTestOnlyObjectExpression({ statement: validExport });
        if (isMultilineObjectExpression({ objectExpression })) {
          return;
        }

        context.report({
          node: objectExpression,
          messageId: 'singleLine',
          fix(fixer) {
            const replacement = buildMultilineObjectReplacement({
              sourceCode: context.sourceCode,
              objectExpression,
            });
            return replacement === undefined
              ? null
              : fixer.replaceText(objectExpression, replacement);
          },
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
