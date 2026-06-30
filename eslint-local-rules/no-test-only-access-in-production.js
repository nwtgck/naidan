import {
  isInsideGuardedTestOnlyPayload,
  isTestOnlyPropertyName,
  isTestSupportFilename,
} from './test-only-guard.js';

const runtimeTypeScriptExpressionTypes = new Set([
  'TSAsExpression',
  'TSInstantiationExpression',
  'TSNonNullExpression',
  'TSSatisfiesExpression',
  'TSTypeAssertion',
]);

function isTypeOnlyIdentifier(node) {
  let current = node;

  while (current.parent != null) {
    const parent = current.parent;
    if (parent.type.startsWith('TS')) {
      if (
        runtimeTypeScriptExpressionTypes.has(parent.type)
        && parent.expression === current
      ) {
        current = parent;
        continue;
      }

      return true;
    }

    return false;
  }

  return false;
}

function isHandledIdentifierPosition(node) {
  const parent = node.parent;

  if (parent.type === 'VariableDeclarator' && parent.id === node) {
    return true;
  }

  if (
    (
      parent.type === 'FunctionDeclaration'
      || parent.type === 'FunctionExpression'
      || parent.type === 'ClassDeclaration'
      || parent.type === 'ClassExpression'
    )
    && parent.id === node
  ) {
    return true;
  }

  if (
    parent.type === 'ImportSpecifier'
    || parent.type === 'ImportDefaultSpecifier'
    || parent.type === 'ImportNamespaceSpecifier'
    || parent.type === 'ExportSpecifier'
  ) {
    return true;
  }

  if (parent.type === 'MemberExpression') {
    return true;
  }

  if (parent.type === 'Property') {
    if (parent.parent.type === 'ObjectPattern') {
      return true;
    }

    return parent.key === node && !parent.computed && !parent.shorthand;
  }

  if (
    (
      parent.type === 'MethodDefinition'
      || parent.type === 'PropertyDefinition'
    )
    && parent.key === node
    && !parent.computed
  ) {
    return true;
  }

  return (
    (parent.type === 'LabeledStatement' && parent.label === node)
    || (parent.type === 'BreakStatement' && parent.label === node)
    || (parent.type === 'ContinueStatement' && parent.label === node)
  );
}

function isTestOnlyMemberExpression(node) {
  return isTestOnlyPropertyName(node.property)
    || (
      node.object.type === 'Identifier'
      && isTestOnlyPropertyName(node.object)
    );
}

export const rule = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Disallow test-only API access from production code.',
    },
    messages: {
      forbiddenAccess: 'TEST_ONLY APIs may only be accessed by tests or from within a guarded test-only payload.',
      forbiddenImport: 'TEST_ONLY imports and re-exports are only allowed in test support files.',
    },
  },
  create(context) {
    if (isTestSupportFilename(context.filename)) {
      return {};
    }

    return {
      Identifier(node) {
        if (
          !isTestOnlyPropertyName(node)
          || isInsideGuardedTestOnlyPayload(node)
          || isTypeOnlyIdentifier(node)
          || isHandledIdentifierPosition(node)
        ) {
          return;
        }

        context.report({
          node,
          messageId: 'forbiddenAccess',
        });
      },
      MemberExpression(node) {
        if (
          !isTestOnlyMemberExpression(node)
          || isInsideGuardedTestOnlyPayload(node)
        ) {
          return;
        }

        context.report({
          node,
          messageId: 'forbiddenAccess',
        });
      },
      Property(node) {
        if (
          node.parent.type !== 'ObjectPattern'
          || !isTestOnlyPropertyName(node.key)
        ) {
          return;
        }

        context.report({
          node,
          messageId: 'forbiddenAccess',
        });
      },
      ImportSpecifier(node) {
        if (
          !isTestOnlyPropertyName(node.imported)
          && !isTestOnlyPropertyName(node.local)
        ) {
          return;
        }

        context.report({
          node,
          messageId: 'forbiddenImport',
        });
      },
      ImportDefaultSpecifier(node) {
        if (!isTestOnlyPropertyName(node.local)) {
          return;
        }

        context.report({
          node,
          messageId: 'forbiddenImport',
        });
      },
      ImportNamespaceSpecifier(node) {
        if (!isTestOnlyPropertyName(node.local)) {
          return;
        }

        context.report({
          node,
          messageId: 'forbiddenImport',
        });
      },
      ExportSpecifier(node) {
        if (
          !isTestOnlyPropertyName(node.local)
          && !isTestOnlyPropertyName(node.exported)
        ) {
          return;
        }

        context.report({
          node,
          messageId: 'forbiddenImport',
        });
      },
      ExportAllDeclaration(node) {
        if (
          node.exported === null
          || !isTestOnlyPropertyName(node.exported)
        ) {
          return;
        }

        context.report({
          node,
          messageId: 'forbiddenImport',
        });
      },
    };
  },
};

export default {
  files: ['**/*.ts', '**/*.tsx', '**/*.vue'],
  plugins: {
    'local-rules-no-test-only-access': {
      rules: {
        'no-test-only-access-in-production': rule,
      },
    },
  },
  rules: {
    'local-rules-no-test-only-access/no-test-only-access-in-production': 'error',
  },
};
