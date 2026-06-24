/**
 * Keep Naidan's application-wide Vue error handler visible in main.ts.
 * The direct assignment is deliberately simple so readers do not need to
 * follow a wrapper to understand how unhandled Vue errors are reported.
 */
export const rule = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Require main.ts to assign app.config.errorHandler directly.',
    },
  },
  create(context) {
    let hasErrorHandlerAssignment = false

    return {
      AssignmentExpression(node) {
        const left = node.left
        if (
          left.type === 'MemberExpression'
          && !left.computed
          && left.object.type === 'MemberExpression'
          && !left.object.computed
          && left.object.object.type === 'Identifier'
          && left.object.object.name === 'app'
          && left.object.property.type === 'Identifier'
          && left.object.property.name === 'config'
          && left.property.type === 'Identifier'
          && left.property.name === 'errorHandler'
        ) {
          hasErrorHandlerAssignment = true
        }
      },
      'Program:exit'(node) {
        if (!hasErrorHandlerAssignment) {
          context.report({
            node,
            message: 'main.ts must assign app.config.errorHandler directly so application-wide Vue error reporting remains visible.',
          })
        }
      },
    }
  },
}

export default {
  files: ['src/main.ts'],
  plugins: {
    'local-rules-vue-error-handler': {
      rules: {
        'ensure-vue-error-handler': rule,
      },
    },
  },
  rules: {
    'local-rules-vue-error-handler/ensure-vue-error-handler': 'error',
  },
}
