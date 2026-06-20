/**
 * Disallow XSS-prone browser APIs in Naidan-owned source code.
 *
 * Scope:
 * - This is a lint-time source policy for Naidan application code.
 * - It is not a runtime enforcement mechanism.
 * - It is not a CSP policy.
 * - It does not attempt to police bundled third-party library internals.
 *
 * eval(), Function(), and new Function() are banned here because Naidan code
 * should not construct executable JavaScript from strings. This should not be
 * interpreted as a decision to forbid eval-like implementation details inside
 * dependencies at runtime.
 *
 * String-based setTimeout()/setInterval() are also banned. Naidan has no
 * implementation need for evaluating timer callbacks from strings; passing a
 * function is clearer, easier to trace, and avoids treating a string as
 * executable JavaScript.
 */

function normalizePath(filePath) {
  return filePath.replace(/\\/g, '/')
}

function getStaticPropertyName(memberExpression) {
  if (!memberExpression) {
    return undefined
  }

  if (!memberExpression.computed && memberExpression.property?.type === 'Identifier') {
    return memberExpression.property.name
  }

  if (memberExpression.computed && memberExpression.property?.type === 'Literal' && typeof memberExpression.property.value === 'string') {
    return memberExpression.property.value
  }

  return undefined
}

function isIdentifierNamed(node, name) {
  return node?.type === 'Identifier' && node.name === name
}

function isGlobalObjectIdentifier(node) {
  return node?.type === 'Identifier' && ['globalThis', 'self', 'window'].includes(node.name)
}

function isLiteralString(node, value) {
  return node?.type === 'Literal' && typeof node.value === 'string' && node.value.toLowerCase() === value.toLowerCase()
}

function isLiteralStringStartingWith(node, prefix) {
  return node?.type === 'Literal' && typeof node.value === 'string' && node.value.toLowerCase().startsWith(prefix.toLowerCase())
}

function isDocumentObject(node) {
  if (isIdentifierNamed(node, 'document')) {
    return true
  }

  return node?.type === 'MemberExpression' && isGlobalObjectIdentifier(node.object) && getStaticPropertyName(node) === 'document'
}

function isDocumentMemberCall(node, methodName) {
  return node.callee?.type === 'MemberExpression' && isDocumentObject(node.callee.object) && getStaticPropertyName(node.callee) === methodName
}

function isGlobalOrMemberCall(node, names) {
  if (node.callee?.type === 'Identifier') {
    return names.has(node.callee.name)
  }

  if (node.callee?.type === 'MemberExpression' && isGlobalObjectIdentifier(node.callee.object)) {
    const propertyName = getStaticPropertyName(node.callee)
    return typeof propertyName === 'string' && names.has(propertyName)
  }

  return false
}

function isFunctionConstructor(node) {
  if (node.callee?.type === 'Identifier') {
    return node.callee.name === 'Function'
  }

  return node.callee?.type === 'MemberExpression' && isGlobalObjectIdentifier(node.callee.object) && getStaticPropertyName(node.callee) === 'Function'
}

function isWorkerConstructor(node) {
  if (node.callee?.type === 'Identifier') {
    return node.callee.name === 'Worker' || node.callee.name === 'SharedWorker'
  }

  if (node.callee?.type === 'MemberExpression' && isGlobalObjectIdentifier(node.callee.object)) {
    const propertyName = getStaticPropertyName(node.callee)
    return propertyName === 'Worker' || propertyName === 'SharedWorker'
  }

  return false
}

function isStaticViteWorkerUrl(node) {
  return (
    node?.type === 'NewExpression' &&
    node.callee?.type === 'Identifier' &&
    node.callee.name === 'URL' &&
    node.arguments[0]?.type === 'Literal' &&
    typeof node.arguments[0].value === 'string' &&
    node.arguments[1]?.type === 'MemberExpression' &&
    node.arguments[1].object?.type === 'MetaProperty' &&
    node.arguments[1].object.meta?.name === 'import' &&
    node.arguments[1].object.property?.name === 'meta' &&
    getStaticPropertyName(node.arguments[1]) === 'url'
  )
}

function isServiceWorkerRegisterCall(node) {
  if (node.callee?.type !== 'MemberExpression' || getStaticPropertyName(node.callee) !== 'register') {
    return false
  }

  const calleeObject = node.callee.object
  return calleeObject?.type === 'MemberExpression' && getStaticPropertyName(calleeObject) === 'serviceWorker'
}

function isAllowedExceptionFile({ filePath }) {
  const normalized = normalizePath(filePath)
  return (
    normalized.endsWith('/src/components/common/AllowedHtmlView.vue') ||
    normalized.endsWith('/src/lib/security/allowedHtmlDom.ts') ||
    normalized.endsWith('/src/services/worker-hub-standalone-loader.ts') ||
    normalized.endsWith('/src/components/block-markdown/test-utils.ts')
  )
}

const htmlAssignmentProperties = new Set(['innerHTML', 'outerHTML', 'srcdoc'])
const htmlCallProperties = new Set(['insertAdjacentHTML', 'createContextualFragment'])
const dangerousMimeTypes = new Set(['text/html', 'application/xhtml+xml', 'image/svg+xml'])
const stringTimerNames = new Set(['setTimeout', 'setInterval'])
const evalLikeNames = new Set(['eval', 'Function'])

export const rule = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Disallow XSS-prone browser APIs in Naidan-owned source code.',
    },
    messages: {
      noDocumentWrite: 'document.write()/document.writeln() are completely banned in Naidan source code.',
      noEvalLike: 'Do not construct executable JavaScript from strings in Naidan source code.',
      noStringTimer: 'Use function callbacks for setTimeout()/setInterval(); string-based timers are banned.',
      noHtmlSink: 'Do not use raw HTML sinks directly. Use AllowedHtmlView or a dedicated AllowedHtml wrapper.',
      noScriptElement: 'Do not dynamically create script elements in Naidan source code.',
      noEventAttribute: 'Do not set event handler attributes with setAttribute(). Use event listeners or Vue bindings.',
      noScriptLikeWorker: 'Do not create workers from dynamic URLs. Use new URL("./worker.ts", import.meta.url) unless this file has an explicit exception.',
    },
    schema: [],
  },
  create(context) {
    if (isAllowedExceptionFile({ filePath: context.filename ?? context.getFilename?.() ?? '' })) {
      return {}
    }

    return {
      AssignmentExpression(node) {
        const left = node.left
        if (left.type === 'MemberExpression' && htmlAssignmentProperties.has(getStaticPropertyName(left))) {
          context.report({ node, messageId: 'noHtmlSink' })
        }
      },
      CallExpression(node) {
        if (isDocumentMemberCall(node, 'write') || isDocumentMemberCall(node, 'writeln')) {
          context.report({ node, messageId: 'noDocumentWrite' })
          return
        }

        if (isGlobalOrMemberCall(node, evalLikeNames)) {
          context.report({ node, messageId: 'noEvalLike' })
          return
        }

        if (isGlobalOrMemberCall(node, stringTimerNames) && node.arguments[0]?.type === 'Literal' && typeof node.arguments[0].value === 'string') {
          context.report({ node, messageId: 'noStringTimer' })
          return
        }

        if (isDocumentMemberCall(node, 'createElement') && isLiteralString(node.arguments[0], 'script')) {
          context.report({ node, messageId: 'noScriptElement' })
          return
        }

        if (node.callee?.type === 'Identifier' && node.callee.name === 'importScripts') {
          context.report({ node, messageId: 'noScriptLikeWorker' })
          return
        }

        if (isServiceWorkerRegisterCall(node)) {
          context.report({ node, messageId: 'noScriptLikeWorker' })
          return
        }

        if (node.callee?.type === 'MemberExpression') {
          const propertyName = getStaticPropertyName(node.callee)
          if (htmlCallProperties.has(propertyName)) {
            context.report({ node, messageId: 'noHtmlSink' })
            return
          }

          if (propertyName === 'setAttribute') {
            if (isLiteralStringStartingWith(node.arguments[0], 'on')) {
              context.report({ node, messageId: 'noEventAttribute' })
              return
            }
            if (isLiteralString(node.arguments[0], 'srcdoc')) {
              context.report({ node, messageId: 'noHtmlSink' })
              return
            }
          }

          if (propertyName === 'parseFromString' && node.arguments[1]?.type === 'Literal' && typeof node.arguments[1].value === 'string' && dangerousMimeTypes.has(node.arguments[1].value.toLowerCase())) {
            context.report({ node, messageId: 'noHtmlSink' })
          }
        }
      },
      NewExpression(node) {
        if (isFunctionConstructor(node)) {
          context.report({ node, messageId: 'noEvalLike' })
          return
        }

        if (isWorkerConstructor(node) && !isStaticViteWorkerUrl(node.arguments[0])) {
          context.report({ node, messageId: 'noScriptLikeWorker' })
        }
      },
    }
  },
}

export default {
  files: ['src/**/*.ts', 'src/**/*.vue'],
  ignores: ['src/**/*.test.ts', 'src/**/*.spec.ts', 'src/**/test-utils.ts'],
  plugins: {
    'local-rules-xss-prone-browser-apis': {
      rules: {
        'no-xss-prone-browser-apis': rule,
      },
    },
  },
  rules: {
    'local-rules-xss-prone-browser-apis/no-xss-prone-browser-apis': 'error',
  },
}
