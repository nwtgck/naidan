/**
 * Enforce the ready-state-aware application startup boundary.
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
      description: 'Enforce ready-state-aware Vue initialization for asynchronous entry loading.',
    },
  },
  create(context) {
    let bootstrapFunctionName
    const functionStack = []
    const functionsContainingMount = new Set()

    return {
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
    'local-rules-ready-state-startup': {
      rules: {
        'ensure-ready-state-aware-app-startup': rule,
      },
    },
  },
  rules: {
    'local-rules-ready-state-startup/ensure-ready-state-aware-app-startup': 'error',
  },
}
