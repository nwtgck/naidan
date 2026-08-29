function normalizePath(filename) {
  return filename.replace(/\\/g, '/');
}

function isTestFile(filename) {
  return /\.(?:test|spec)\.(?:ts|tsx|js|jsx)$/.test(filename);
}

function matchesSuffix({ filename, suffixes }) {
  return suffixes.some(suffix => filename.endsWith(suffix));
}

function isWorkerTransportInfrastructureFile(filename) {
  return filename.endsWith('/src/utils/worker-transport.ts');
}

function getObjectTypeInfo(context, node) {
  const services = context.sourceCode.parserServices;
  if (!services?.program || !services.esTreeNodeToTSNodeMap) return undefined;
  const checker = services.program.getTypeChecker();
  const tsNode = services.esTreeNodeToTSNodeMap.get(node);
  if (!tsNode) return undefined;
  const type = checker.getTypeAtLocation(tsNode);
  return { type, checker, displayName: checker.typeToString(type) };
}

function collectTypeHierarchyNames(type, names = new Set(), seen = new Set()) {
  if (seen.has(type)) return names;
  seen.add(type);

  if (type.isUnionOrIntersection()) {
    for (const member of type.types) collectTypeHierarchyNames(member, names, seen);
  }

  const symbol = type.aliasSymbol ?? type.getSymbol();
  if (symbol) names.add(symbol.getName());
  const targetSymbol = type.target?.getSymbol?.();
  if (targetSymbol) names.add(targetSymbol.getName());

  for (const base of type.getBaseTypes?.() ?? []) {
    collectTypeHierarchyNames(base, names, seen);
  }
  return names;
}

function isWorkerMessageEndpoint(type) {
  if (!type) return false;
  const names = collectTypeHierarchyNames(type);
  return ['Worker', 'SharedWorker', 'MessagePort', 'DedicatedWorkerGlobalScope']
    .some(name => names.has(name));
}

function isComlinkModuleSpecifier(value) {
  return typeof value === 'string' && (value === 'comlink' || value.startsWith('comlink/'));
}

function staticMemberName(node) {
  if (!node.computed && node.property.type === 'Identifier') return node.property.name;
  if (node.computed && node.property.type === 'Literal' && typeof node.property.value === 'string') return node.property.value;
  if (node.computed && node.property.type === 'TemplateLiteral' && node.property.expressions.length === 0) {
    return node.property.quasis[0]?.value.cooked ?? undefined;
  }
  return undefined;
}

function staticStringValue(node) {
  if (node?.type === 'Literal' && typeof node.value === 'string') return node.value;
  if (node?.type === 'TemplateLiteral' && node.expressions.length === 0) return node.quasis[0]?.value.cooked ?? undefined;
  return undefined;
}

function staticPatternPropertyName(property) {
  if (property.type !== 'Property') return undefined;
  if (!property.computed && property.key.type === 'Identifier') return property.key.name;
  if (property.key.type === 'Literal' && typeof property.key.value === 'string') return property.key.value;
  if (property.key.type === 'TemplateLiteral' && property.key.expressions.length === 0) {
    return property.key.quasis[0]?.value.cooked ?? undefined;
  }
  return undefined;
}

export const rule = {
  meta: {
    type: 'problem',
    schema: [{
      type: 'object',
      properties: {
        legacyComlinkFileSuffixes: { type: 'array', items: { type: 'string' }, uniqueItems: true },
        legacyRawTransportFileSuffixes: { type: 'array', items: { type: 'string' }, uniqueItems: true },
      },
      additionalProperties: false,
    }],
    messages: {
      directComlink: 'Do not use comlink directly. Use the project-owned worker transport API.',
      directPostMessage: '{{ typeName }}.postMessage must not be called directly. Use the audited worker transport.',
      directMessageListener: 'Do not register message listeners directly on {{ typeName }}. Use the audited worker transport.',
      dynamicWorkerMember: 'Dynamic member access on {{ typeName }} is not allowed because it can bypass the worker transport boundary.',
    },
  },
  create(context) {
    const filename = normalizePath(context.filename);
    if (isTestFile(filename) || isWorkerTransportInfrastructureFile(filename)) return {};
    const options = context.options[0] ?? {};
    const allowLegacyComlink = matchesSuffix({ filename, suffixes: options.legacyComlinkFileSuffixes ?? [] });
    const allowLegacyRawTransport = matchesSuffix({ filename, suffixes: options.legacyRawTransportFileSuffixes ?? [] });
    const reportDirectComlink = node => {
      if (!allowLegacyComlink) context.report({ node, messageId: 'directComlink' });
    };
    return {
      ImportDeclaration(node) {
        if (isComlinkModuleSpecifier(node.source.value)) reportDirectComlink(node);
      },
      ExportNamedDeclaration(node) {
        if (isComlinkModuleSpecifier(node.source?.value)) reportDirectComlink(node);
      },
      ExportAllDeclaration(node) {
        if (isComlinkModuleSpecifier(node.source.value)) reportDirectComlink(node);
      },
      ImportExpression(node) {
        if (node.source.type === 'Literal' && isComlinkModuleSpecifier(node.source.value)) reportDirectComlink(node);
      },
      CallExpression(node) {
        if (node.callee.type === 'Identifier' && node.callee.name === 'require'
          && node.arguments[0]?.type === 'Literal' && isComlinkModuleSpecifier(node.arguments[0].value)) {
          reportDirectComlink(node);
        }
        if (allowLegacyRawTransport) return;
        if (node.callee.type !== 'MemberExpression' || node.callee.computed) return;
        if (node.callee.object.type !== 'Identifier' || node.callee.object.name !== 'Reflect') return;
        if (node.callee.property.type !== 'Identifier' || !['get', 'set'].includes(node.callee.property.name)) return;
        const target = node.arguments[0];
        if (!target || target.type === 'SpreadElement') return;
        const typeInfo = getObjectTypeInfo(context, target);
        if (!isWorkerMessageEndpoint(typeInfo?.type)) return;
        const typeName = typeInfo?.displayName ?? 'Worker endpoint';
        const propertyName = staticStringValue(node.arguments[1]);
        if (propertyName === undefined) {
          context.report({ node, messageId: 'dynamicWorkerMember', data: { typeName } });
        } else if (propertyName === 'postMessage') {
          context.report({ node, messageId: 'directPostMessage', data: { typeName } });
        } else if (propertyName === 'onmessage' || propertyName === 'addEventListener') {
          context.report({ node, messageId: 'directMessageListener', data: { typeName } });
        }
      },
      ObjectPattern(node) {
        if (allowLegacyRawTransport) return;
        const typeInfo = getObjectTypeInfo(context, node);
        if (!isWorkerMessageEndpoint(typeInfo?.type)) return;
        const typeName = typeInfo?.displayName ?? 'Worker endpoint';
        for (const property of node.properties) {
          if (property.type === 'RestElement') continue;
          const memberName = staticPatternPropertyName(property);
          if (memberName === undefined) {
            if (property.computed) {
              context.report({ node: property, messageId: 'dynamicWorkerMember', data: { typeName } });
            }
            continue;
          }
          if (memberName === 'postMessage') {
            context.report({ node: property, messageId: 'directPostMessage', data: { typeName } });
          } else if (memberName === 'onmessage' || memberName === 'addEventListener') {
            context.report({ node: property, messageId: 'directMessageListener', data: { typeName } });
          }
        }
      },
      MemberExpression(node) {
        if (allowLegacyRawTransport) return;
        const typeInfo = getObjectTypeInfo(context, node.object);
        if (!isWorkerMessageEndpoint(typeInfo?.type)) return;
        const typeName = typeInfo?.displayName ?? 'Worker endpoint';
        const memberName = staticMemberName(node);
        if (memberName === undefined) {
          if (node.computed) {
            context.report({ node, messageId: 'dynamicWorkerMember', data: { typeName } });
          }
          return;
        }
        if (memberName === 'postMessage') {
          context.report({ node, messageId: 'directPostMessage', data: { typeName } });
          return;
        }
        if (memberName === 'onmessage') {
          context.report({ node, messageId: 'directMessageListener', data: { typeName } });
          return;
        }
        if (memberName !== 'addEventListener') return;

        const parent = node.parent;
        if (parent?.type === 'CallExpression' && parent.callee === node) {
          const eventName = staticStringValue(parent.arguments[0]);
          if (eventName !== undefined && eventName !== 'message') return;
        }
        context.report({ node, messageId: 'directMessageListener', data: { typeName } });
      },
    };
  },
};

export default {
  files: ['**/*.ts', '**/*.tsx', '**/*.vue'],
  plugins: {
    'local-rules-worker-transport': {
      rules: {
        'no-unchecked-worker-transport': rule,
      },
    },
  },
  rules: {
    'local-rules-worker-transport/no-unchecked-worker-transport': ['error', {
      legacyComlinkFileSuffixes: [],
      legacyRawTransportFileSuffixes: [],
    }],
  },
};
