export function getStaticString(node) {
  return node?.type === 'Literal' && typeof node.value === 'string'
    ? node.value
    : undefined;
}

export function getStaticPropertyName(node) {
  if (node?.type !== 'MemberExpression') return undefined;
  if (!node.computed && node.property.type === 'Identifier') return node.property.name;
  return node.computed ? getStaticString(node.property) : undefined;
}

function findVariable({ name, scope }) {
  let current = scope;
  while (current !== null) {
    const variable = current.set.get(name);
    if (variable !== undefined) return variable;
    current = current.upper;
  }
  return undefined;
}

export function isUnshadowedGlobalIdentifier({ node, sourceCode }) {
  if (node?.type !== 'Identifier') return false;
  const variable = findVariable({ name: node.name, scope: sourceCode.getScope(node) });
  return variable === undefined || variable.defs.length === 0;
}

export function isGlobalObject({ node, sourceCode }) {
  return node?.type === 'Identifier'
    && ['globalThis', 'self', 'window'].includes(node.name)
    && isUnshadowedGlobalIdentifier({ node, sourceCode });
}

export function isStaticRequireCall({ node, sourceCode }) {
  return node?.type === 'CallExpression'
    && node.callee.type === 'Identifier'
    && node.callee.name === 'require'
    && isUnshadowedGlobalIdentifier({ node: node.callee, sourceCode });
}

