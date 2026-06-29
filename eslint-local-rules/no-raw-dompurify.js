function normalizePath(filePath) {
  return filePath.replace(/\\/g, '/');
}

function isAllowedHtmlImplementationFile({ filePath }) {
  return normalizePath(filePath).endsWith('/src/logic/security/allowedHtml.ts');
}

export const rule = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Disallow direct DOMPurify imports outside the AllowedHtml security module.',
    },
    messages: {
      noRawDompurify: 'Do not import DOMPurify directly. Centralize HTML sanitization in src/logic/security/allowedHtml.ts.',
    },
    schema: [],
  },
  create(context) {
    if (isAllowedHtmlImplementationFile({ filePath: context.filename ?? context.getFilename?.() ?? '' })) {
      return {};
    }

    return {
      ImportDeclaration(node) {
        if (node.source.value === 'dompurify') {
          context.report({ node, messageId: 'noRawDompurify' });
        }
      },
    };
  },
};

export default {
  files: ['src/**/*.ts', 'src/**/*.vue'],
  ignores: ['src/**/*.test.ts', 'src/**/*.spec.ts'],
  plugins: {
    'local-rules-raw-dompurify': {
      rules: {
        'no-raw-dompurify': rule,
      },
    },
  },
  rules: {
    'local-rules-raw-dompurify/no-raw-dompurify': 'error',
  },
};
