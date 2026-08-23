import {
  getStaticPropertyName,
  getStaticString,
  isGlobalObject,
  isStaticRequireCall,
  isUnshadowedGlobalIdentifier,
} from './hizofs-ast-guards.js';

const networkModuleRoots = new Set([
  'axios',
  'dgram',
  'dns',
  'got',
  'http',
  'http2',
  'https',
  'net',
  'node-fetch',
  'superagent',
  'tls',
  'undici',
]);

const networkWrapperPrefixes = [
  '@/features/lm/fetch',
  '@/features/lm/fetchFactory',
  '@/features/privacy-fetch',
  '@/utils/ollama-detection',
];

const browserFunctionNames = new Set(['fetch', 'importScripts']);
const browserConstructorNames = new Set([
  'Audio',
  'EventSource',
  'Image',
  'RTCPeerConnection',
  'WebSocket',
  'WebSocketStream',
  'WebTransport',
  'XMLHttpRequest',
]);

const workletPropertyNames = new Set([
  'animationWorklet',
  'audioWorklet',
  'layoutWorklet',
  'paintWorklet',
]);

function moduleRoot(specifier) {
  const withoutNodePrefix = specifier.startsWith('node:') ? specifier.slice(5) : specifier;
  return withoutNodePrefix.split('/')[0];
}

function isNetworkModule(specifier) {
  return networkModuleRoots.has(moduleRoot(specifier));
}

function isNetworkWrapper(specifier) {
  return networkWrapperPrefixes.some(prefix => specifier === prefix || specifier.startsWith(`${prefix}/`));
}

function isRemoteModuleSpecifier(specifier) {
  return /^(?:https?|wss?):\/\//u.test(specifier);
}

function isNavigatorObject({ node, sourceCode }) {
  if (node?.type === 'Identifier') {
    return node.name === 'navigator' && isUnshadowedGlobalIdentifier({ node, sourceCode });
  }
  return node?.type === 'MemberExpression'
    && isGlobalObject({ node: node.object, sourceCode })
    && getStaticPropertyName(node) === 'navigator';
}

function isDocumentObject({ node, sourceCode }) {
  if (node?.type === 'Identifier') {
    return node.name === 'document' && isUnshadowedGlobalIdentifier({ node, sourceCode });
  }
  return node?.type === 'MemberExpression'
    && isGlobalObject({ node: node.object, sourceCode })
    && getStaticPropertyName(node) === 'document';
}

function isLocationObject({ node, sourceCode }) {
  if (node?.type === 'Identifier') {
    return node.name === 'location' && isUnshadowedGlobalIdentifier({ node, sourceCode });
  }
  if (node?.type !== 'MemberExpression' || getStaticPropertyName(node) !== 'location') return false;
  return isGlobalObject({ node: node.object, sourceCode })
    || isDocumentObject({ node: node.object, sourceCode });
}

function navigationApiName({ node, sourceCode }) {
  if (node?.type !== 'MemberExpression') return undefined;
  const propertyName = getStaticPropertyName(node);
  if ((propertyName === 'assign' || propertyName === 'replace')
    && isLocationObject({ node: node.object, sourceCode })) {
    return `location.${propertyName}`;
  }
  if (propertyName === 'open' && isGlobalObject({ node: node.object, sourceCode })) {
    return 'window.open';
  }
  return undefined;
}

function navigationAssignmentName({ node, sourceCode }) {
  if (node?.type === 'Identifier' && isLocationObject({ node, sourceCode })) return 'location';
  if (node?.type !== 'MemberExpression') return undefined;
  const propertyName = getStaticPropertyName(node);
  if (propertyName === 'href' && isLocationObject({ node: node.object, sourceCode })) {
    return 'location.href';
  }
  if (propertyName === 'location'
    && (isGlobalObject({ node: node.object, sourceCode }) || isDocumentObject({ node: node.object, sourceCode }))) {
    return 'window.location';
  }
  return undefined;
}

function browserApiName({ node, sourceCode }) {
  if (node?.type === 'Identifier'
    && (browserFunctionNames.has(node.name) || browserConstructorNames.has(node.name))
    && isUnshadowedGlobalIdentifier({ node, sourceCode })) {
    return node.name;
  }
  if (node?.type !== 'MemberExpression') return undefined;
  const propertyName = getStaticPropertyName(node);
  if (propertyName !== undefined && ['apply', 'bind', 'call'].includes(propertyName)) {
    return browserApiName({ node: node.object, sourceCode });
  }
  if (propertyName !== undefined
    && (browserFunctionNames.has(propertyName) || browserConstructorNames.has(propertyName))
    && isGlobalObject({ node: node.object, sourceCode })) {
    return propertyName;
  }
  if (propertyName === 'sendBeacon' && isNavigatorObject({ node: node.object, sourceCode })) {
    return 'navigator.sendBeacon';
  }
  if (propertyName === 'serviceWorker' && isNavigatorObject({ node: node.object, sourceCode })) {
    return 'navigator.serviceWorker';
  }
  if (propertyName !== undefined && workletPropertyNames.has(propertyName)) {
    return propertyName;
  }
  return undefined;
}

function isDocumentCapability({ node, sourceCode }) {
  if (node?.type === 'Identifier') {
    return node.name === 'document' && isUnshadowedGlobalIdentifier({ node, sourceCode });
  }
  return node?.type === 'MemberExpression'
    && isGlobalObject({ node: node.object, sourceCode })
    && getStaticPropertyName(node) === 'document';
}

function isStaticPropertyKey(node) {
  return (node.parent?.type === 'MemberExpression'
      && node.parent.property === node
      && !node.parent.computed)
    || (node.parent?.type === 'Property'
      && node.parent.key === node
      && !node.parent.computed);
}

function reportModule({ context, node, specifier }) {
  if (isRemoteModuleSpecifier(specifier)) {
    context.report({ data: { specifier }, messageId: 'remoteModule', node });
    return;
  }
  if (isNetworkModule(specifier) || isNetworkWrapper(specifier)) {
    context.report({ data: { specifier }, messageId: 'networkModule', node });
  }
}

function reportApiReference({ context, node, sourceCode }) {
  const api = browserApiName({ node, sourceCode });
  if (api === undefined) return false;
  context.report({ data: { api }, messageId: 'browserNetworkApi', node });
  return true;
}

export const rule = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Prevent HizoFS from initiating internet, localhost, or same-origin network communication.',
    },
    messages: {
      browserNetworkApi: 'HizoFS must not use {{api}}; runtime network communication is forbidden regardless of destination.',
      documentCapability: 'HizoFS must not reference the browser document; DOM and resource-loading ownership is outside the HizoFS boundary.',
      navigationSideEffect: 'HizoFS must not use {{api}}; navigation side effects are outside the HizoFS boundary.',
      networkModule: 'HizoFS must not import {{specifier}}; network client modules and Naidan network wrappers are outside the HizoFS boundary.',
      remoteModule: 'HizoFS must not load remote module {{specifier}}; only project-local module loading is allowed.',
    },
    schema: [],
  },
  create(context) {
    const sourceCode = context.sourceCode ?? context.getSourceCode();
    return {
      AssignmentExpression(node) {
        const navigation = navigationAssignmentName({ node: node.left, sourceCode });
        if (navigation !== undefined) {
          context.report({ data: { api: navigation }, messageId: 'navigationSideEffect', node });
        }
      },
      CallExpression(node) {
        if (isStaticRequireCall({ node, sourceCode })) {
          const specifier = getStaticString(node.arguments[0]);
          if (specifier !== undefined) reportModule({ context, node, specifier });
          return;
        }
        const navigation = navigationApiName({ node: node.callee, sourceCode });
        if (navigation !== undefined) {
          context.report({ data: { api: navigation }, messageId: 'navigationSideEffect', node });
        }
      },
      ImportDeclaration(node) {
        reportModule({ context, node, specifier: node.source.value });
      },
      ImportExpression(node) {
        const specifier = getStaticString(node.source);
        if (specifier !== undefined) reportModule({ context, node, specifier });
      },
      Identifier(node) {
        if (isStaticPropertyKey(node)) return;
        if (isDocumentCapability({ node, sourceCode })) {
          context.report({ messageId: 'documentCapability', node });
          return;
        }
        reportApiReference({ context, node, sourceCode });
      },
      MemberExpression(node) {
        if (isDocumentCapability({ node, sourceCode })) {
          context.report({ messageId: 'documentCapability', node });
          return;
        }
        const propertyName = getStaticPropertyName(node);
        if (!['apply', 'bind', 'call'].includes(propertyName)) {
          reportApiReference({ context, node, sourceCode });
        }
      },
      VariableDeclarator(node) {
        const navigation = navigationApiName({ node: node.init, sourceCode });
        if (navigation !== undefined) {
          context.report({ data: { api: navigation }, messageId: 'navigationSideEffect', node });
        }
        if (node.id.type !== 'ObjectPattern') return;
        const destructuredGlobal = isGlobalObject({ node: node.init, sourceCode });
        const destructuredNavigator = isNavigatorObject({ node: node.init, sourceCode });
        if (!destructuredGlobal && !destructuredNavigator) return;
        for (const property of node.id.properties) {
          if (property.type !== 'Property') continue;
          const name = property.computed ? getStaticString(property.key) : property.key.type === 'Identifier' ? property.key.name : getStaticString(property.key);
          if (name === 'document' && destructuredGlobal) {
            context.report({ messageId: 'documentCapability', node: property });
          } else if (name !== undefined && (destructuredGlobal && (browserFunctionNames.has(name) || browserConstructorNames.has(name))
            || destructuredNavigator && (name === 'sendBeacon' || name === 'serviceWorker'))) {
            context.report({ data: { api: name }, messageId: 'browserNetworkApi', node: property });
          }
        }
      },
    };
  },
};

export default {
  files: ['src/00-storage/service/hizofs/**/*.{js,mjs,cjs,ts,tsx}'],
  plugins: {
    'local-rules-hizofs-network': {
      rules: {
        'no-external-network': rule,
      },
    },
  },
  rules: {
    'local-rules-hizofs-network/no-external-network': 'error',
  },
};
