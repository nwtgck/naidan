function normalizePath(filePath) {
  return filePath.replace(/\\/g, '/');
}

function isAllowedHtmlImplementationFile({ filePath }) {
  return normalizePath(filePath).endsWith('/src/lib/security/allowedHtml.ts');
}

function isAllowedHtmlType({ node, sourceCode }) {
  return /\bAllowedHtml\b/u.test(sourceCode.getText(node.typeAnnotation));
}

export const rule = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Disallow casting to AllowedHtml outside the security module.',
    },
    messages: {
      noAllowedHtmlCast: 'Do not cast to AllowedHtml. Use allowedHtml.ts helpers to create AllowedHtml values.',
    },
    schema: [],
  },
  create(context) {
    if (isAllowedHtmlImplementationFile({ filePath: context.filename ?? context.getFilename?.() ?? '' })) {
      return {};
    }

    const sourceCode = context.sourceCode;
    return {
      TSAsExpression(node) {
        if (isAllowedHtmlType({ node, sourceCode })) {
          context.report({ node, messageId: 'noAllowedHtmlCast' });
        }
      },
      TSTypeAssertion(node) {
        if (isAllowedHtmlType({ node, sourceCode })) {
          context.report({ node, messageId: 'noAllowedHtmlCast' });
        }
      },
    };
  },
};

export default {
  files: ['src/**/*.ts', 'src/**/*.vue'],
  ignores: ['src/**/*.test.ts', 'src/**/*.spec.ts'],
  plugins: {
    'local-rules-allowed-html-cast': {
      rules: {
        'no-allowed-html-cast': rule,
      },
    },
  },
  rules: {
    'local-rules-allowed-html-cast/no-allowed-html-cast': 'error',
  },
};
