/**
 * ESLint configuration chunk to enforce proper Vue app initialization for file:/// protocol compatibility.
 * This is specialized for 'src/main.ts'.
 */
const rule = {
  meta: {
    type: 'problem',
    docs: {
      description: "Enforce proper Vue app initialization for file:/// protocol compatibility.",
    },
  },
  create(context) {
    let hasErrorHandler = false;
    let hasDOMContentLoaded = false;
    let hasMountInsideListener = false;

    return {
      AssignmentExpression(node) {
        const left = node.left;
        if (
          left.type === 'MemberExpression' &&
          left.object.type === 'MemberExpression' &&
          left.object.object.name === 'app' &&
          left.object.property.name === 'config' &&
          left.property.name === 'errorHandler'
        ) {
          hasErrorHandler = true;
        }
      },
      CallExpression(node) {
        const callee = node.callee;
        if (
          callee.type === 'MemberExpression' &&
          callee.object.name === 'window' &&
          callee.property.name === 'addEventListener' &&
          node.arguments[0]?.type === 'Literal' &&
          node.arguments[0].value === 'DOMContentLoaded'
        ) {
          hasDOMContentLoaded = true;
          const callback = node.arguments[1];
          if (callback && (callback.type === 'ArrowFunctionExpression' || callback.type === 'FunctionExpression')) {
            const bodyText = context.getSourceCode().getText(callback.body);
            if (bodyText.includes('app.mount')) {
              hasMountInsideListener = true;
            }
          }
        }
      },
      'Program:exit'(node) {
        if (!hasErrorHandler) {
          context.report({
            node,
            message: "The 'file:///' protocol requires a global error handler: 'app.config.errorHandler = ...' must be defined in main.ts."
          });
        }
        if (!hasDOMContentLoaded) {
          context.report({
            node,
            message: "To support 'file:///' protocol, Vue app must be mounted inside a 'DOMContentLoaded' event listener."
          });
        } else if (!hasMountInsideListener) {
          context.report({
            node,
            message: "Vue app must be mounted using 'app.mount()' inside the 'DOMContentLoaded' listener."
          });
        }
      }
    };
  }
};

export default {
  files: ['src/main.ts'],
  plugins: {
    'local-rules': {
      rules: {
        'ensure-file-protocol-init': rule
      }
    }
  },
  rules: {
    'local-rules/ensure-file-protocol-init': 'error'
  }
};