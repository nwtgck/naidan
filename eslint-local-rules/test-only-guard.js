export const GUARDED_TEST_ONLY_EXAMPLE = `...((__BUILD_MODE_IS_TEST__ && {
  TEST_ONLY: {
    // test API
  },
}) || {})`;

export const GUARDED_TEST_ONLY_NAMED_EXPORT_EXAMPLE = `export const TEST_ONLY_example = (
  __BUILD_MODE_IS_TEST__ && (() => {
    // test API
  })
) || undefined;`;

function getStaticPropertyName(node) {
  if (node.type === 'Identifier') {
    return node.name;
  }

  if (node.type === 'Literal' && typeof node.value === 'string') {
    return node.value;
  }

  if (
    node.type === 'TemplateLiteral'
    && node.expressions.length === 0
    && node.quasis.length === 1
  ) {
    return node.quasis[0]?.value.cooked ?? node.quasis[0]?.value.raw;
  }

  return undefined;
}

export function isTestOnlyPropertyName(node) {
  return getStaticPropertyName(node) === 'TEST_ONLY';
}

export function isTestOnlyExportIdentifierName(node) {
  const name = getStaticPropertyName(node);
  return name === 'TEST_ONLY' || name?.startsWith('TEST_ONLY_') === true;
}

export function isTestOnlyProperty(node) {
  return node.type === 'Property'
    && node.kind === 'init'
    && isTestOnlyPropertyName(node.key);
}

function isExactTestOnlyProperty(node) {
  return node.type === 'Property'
    && !node.computed
    && node.kind === 'init'
    && !node.method
    && !node.shorthand
    && node.key.type === 'Identifier'
    && node.key.name === 'TEST_ONLY';
}

function isEmptyObjectExpression(node) {
  return node.type === 'ObjectExpression'
    && node.properties.length === 0;
}

function isBuildModeTestIdentifier(node) {
  return node.type === 'Identifier'
    && node.name === '__BUILD_MODE_IS_TEST__';
}

export function containsTestOnlyProperty(node) {
  if (node.type === 'ObjectExpression') {
    return node.properties.some((property) => {
      if (isTestOnlyProperty(property)) {
        return true;
      }

      if (property.type === 'SpreadElement') {
        return containsTestOnlyProperty(property.argument);
      }

      return property.type === 'Property'
        && containsTestOnlyProperty(property.value);
    });
  }

  if (node.type === 'LogicalExpression' || node.type === 'BinaryExpression') {
    return containsTestOnlyProperty(node.left)
      || containsTestOnlyProperty(node.right);
  }

  if (node.type === 'ConditionalExpression') {
    return containsTestOnlyProperty(node.consequent)
      || containsTestOnlyProperty(node.alternate);
  }

  if (node.type === 'CallExpression') {
    return node.arguments.some((argument) => (
      argument.type !== 'SpreadElement'
      && containsTestOnlyProperty(argument)
    ));
  }

  return false;
}

function getGuardedTestOnlySpreadParts(node) {
  if (node.type !== 'SpreadElement') {
    return undefined;
  }

  const fallbackExpression = node.argument;
  if (
    fallbackExpression.type !== 'LogicalExpression'
    || fallbackExpression.operator !== '||'
    || !isEmptyObjectExpression(fallbackExpression.right)
  ) {
    return undefined;
  }

  const guardedExpression = fallbackExpression.left;
  if (
    guardedExpression.type !== 'LogicalExpression'
    || guardedExpression.operator !== '&&'
    || !isBuildModeTestIdentifier(guardedExpression.left)
    || guardedExpression.right.type !== 'ObjectExpression'
    || guardedExpression.right.properties.length !== 1
  ) {
    return undefined;
  }

  const [testOnlyProperty] = guardedExpression.right.properties;
  if (
    testOnlyProperty === undefined
    || !isExactTestOnlyProperty(testOnlyProperty)
    || testOnlyProperty.value.type !== 'ObjectExpression'
  ) {
    return undefined;
  }

  return {
    payload: testOnlyProperty.value,
    testOnlyProperty,
  };
}

export function isGuardedTestOnlySpread(node) {
  return getGuardedTestOnlySpreadParts(node) !== undefined;
}

export function getGuardedTestOnlyExportPayload(node) {
  if (
    node.type !== 'LogicalExpression'
    || node.operator !== '||'
    || node.right.type !== 'Identifier'
    || node.right.name !== 'undefined'
  ) {
    return undefined;
  }

  const guardedExpression = node.left;
  if (
    guardedExpression.type !== 'LogicalExpression'
    || guardedExpression.operator !== '&&'
    || !isBuildModeTestIdentifier(guardedExpression.left)
  ) {
    return undefined;
  }

  return guardedExpression.right;
}

export function isGuardedTestOnlyExportValue(node) {
  return getGuardedTestOnlyExportPayload(node) !== undefined;
}

export function isInsideGuardedTestOnlyPayload(node) {
  const ancestors = new Set([node]);
  let current = node;

  while (current.parent != null) {
    current = current.parent;
    ancestors.add(current);

    if (current.type === 'SpreadElement') {
      const guardedParts = getGuardedTestOnlySpreadParts(current);
      if (
        guardedParts !== undefined
        && (
          ancestors.has(guardedParts.testOnlyProperty)
          || ancestors.has(guardedParts.payload)
        )
      ) {
        return true;
      }
    }

    if (current.type === 'VariableDeclarator' && current.init !== null) {
      const exportPayload = getGuardedTestOnlyExportPayload(current.init);
      if (exportPayload !== undefined && ancestors.has(exportPayload)) {
        return true;
      }
    }
  }

  return false;
}

export function isTestSupportFilename(filename) {
  const normalized = filename.replaceAll('\\', '/');

  return /\.(?:test|spec|test-helpers)\.[cm]?[jt]sx?$/.test(normalized)
    || /(?:^|\/)test-setup\.[cm]?[jt]sx?$/.test(normalized)
    || /(?:^|\/)test-utils(?:\.[cm]?[jt]sx?|\/|$)/.test(normalized)
    || /(?:^|\/)test-mocks(?:\/|$)/.test(normalized)
    || /(?:^|\/)test-tmp(?:\/|$)/.test(normalized);
}
