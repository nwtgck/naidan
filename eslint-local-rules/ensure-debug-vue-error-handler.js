/**
 * Keep Vue error observation in the explicitly Debug-only startup boundary.
 * This prevents future code from treating the observer as a file:// Core
 * requirement or reintroducing ad-hoc app.config.errorHandler assignments.
 */
export const rule = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Require main.ts to install the Debug-only Vue error observer through its named boundary.',
    },
  },
  create(context) {
    let hasDebugInstallerCall = false
    let hasDirectErrorHandlerAssignment = false

    return {
      AssignmentExpression(node) {
        const left = node.left
        if (
          left.type === 'MemberExpression'
          && left.object.type === 'MemberExpression'
          && left.object.object.type === 'Identifier'
          && left.object.object.name === 'app'
          && left.object.property.type === 'Identifier'
          && left.object.property.name === 'config'
          && left.property.type === 'Identifier'
          && left.property.name === 'errorHandler'
        ) {
          hasDirectErrorHandlerAssignment = true
        }
      },
      CallExpression(node) {
        if (node.callee.type !== 'Identifier' || node.callee.name !== 'debugInstallVueErrorHandler') return
        const argument = node.arguments[0]
        if (argument?.type !== 'ObjectExpression') return
        hasDebugInstallerCall = argument.properties.some((property) => (
          property.type === 'Property'
          && !property.computed
          && ((property.key.type === 'Identifier' && property.key.name === 'app')
            || (property.key.type === 'Literal' && property.key.value === 'app'))
          && property.value.type === 'Identifier'
          && property.value.name === 'app'
        ))
      },
      'Program:exit'(node) {
        if (hasDirectErrorHandlerAssignment) {
          context.report({
            node,
            message: 'main.ts must not assign app.config.errorHandler directly; use debugInstallVueErrorHandler({ app }).',
          })
        }
        if (!hasDebugInstallerCall) {
          context.report({
            node,
            message: 'main.ts must call debugInstallVueErrorHandler({ app }) so Vue observation remains explicitly Debug-only.',
          })
        }
      },
    }
  },
}

export default {
  files: ['src/main.ts'],
  plugins: {
    'local-rules-debug-vue-error-handler': {
      rules: {
        'ensure-debug-vue-error-handler': rule,
      },
    },
  },
  rules: {
    'local-rules-debug-vue-error-handler/ensure-debug-vue-error-handler': 'error',
  },
}
