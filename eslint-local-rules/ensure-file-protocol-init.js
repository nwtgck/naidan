/**
 * Enforce the startup boundary required by the file-protocol build.
 *
 * The standalone entry is evaluated asynchronously through SystemJS. On a
 * sufficiently large module graph, DOMContentLoaded may have fired before
 * main.ts executes, so requiring app.mount() inside a future-only event listener
 * recreates the exact white-screen failure this rule is intended to prevent.
 * main.ts must delegate to the ready-state-aware scheduleAppStartup helper and
 * the scheduled bootstrap function must own the Vue mount.
 */
export const rule = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Enforce ready-state-aware Vue initialization for file-protocol compatibility.',
    },
  },
  create(context) {
    let hasErrorHandler = false
    let bootstrapFunctionName
    const functionStack = []
    const functionsContainingMount = new Set()

    return {
      AssignmentExpression(node) {
        const left = node.left
        if (
          left.type === 'MemberExpression'
          && left.object.type === 'MemberExpression'
          && left.object.object.name === 'app'
          && left.object.property.name === 'config'
          && left.property.name === 'errorHandler'
        ) {
          hasErrorHandler = true
        }
      },
      FunctionDeclaration(node) {
        functionStack.push(node.id?.name)
      },
      'FunctionDeclaration:exit'() {
        functionStack.pop()
      },
      CallExpression(node) {
        if (
          node.callee.type === 'MemberExpression'
          && !node.callee.computed
          && node.callee.object.type === 'Identifier'
          && node.callee.object.name === 'app'
          && node.callee.property.type === 'Identifier'
          && node.callee.property.name === 'mount'
        ) {
          const currentFunctionName = functionStack.at(-1)
          if (currentFunctionName !== undefined) {
            functionsContainingMount.add(currentFunctionName)
          }
        }

        if (node.callee.type !== 'Identifier' || node.callee.name !== 'scheduleAppStartup') return
        const argument = node.arguments[0]
        if (argument?.type !== 'ObjectExpression') return
        const bootstrapProperty = argument.properties.find((property) => (
          property.type === 'Property'
          && !property.computed
          && ((property.key.type === 'Identifier' && property.key.name === 'bootstrap')
            || (property.key.type === 'Literal' && property.key.value === 'bootstrap'))
        ))
        if (bootstrapProperty?.type !== 'Property') return
        if (bootstrapProperty.value.type === 'Identifier') {
          bootstrapFunctionName = bootstrapProperty.value.name
        }
      },
      'Program:exit'(node) {
        if (!hasErrorHandler) {
          context.report({
            node,
            message: "The 'file:///' protocol requires a global error handler: 'app.config.errorHandler = ...' must be defined in main.ts.",
          })
        }
        if (bootstrapFunctionName === undefined) {
          context.report({
            node,
            message: 'To support asynchronous file-protocol entry loading, main.ts must call scheduleAppStartup() with a bootstrap function.',
          })
          return
        }
        if (!functionsContainingMount.has(bootstrapFunctionName)) {
          context.report({
            node,
            message: 'The bootstrap function passed to scheduleAppStartup() must contain app.mount().',
          })
        }
      },
    }
  },
}

export default {
  files: ['src/main.ts'],
  plugins: {
    'local-rules': {
      rules: {
        'ensure-file-protocol-init': rule,
      },
    },
  },
  rules: {
    'local-rules/ensure-file-protocol-init': 'error',
  },
}
