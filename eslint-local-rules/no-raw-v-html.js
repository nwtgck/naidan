function normalizePath(filePath) {
  return filePath.replace(/\\/g, '/');
}

function isAllowedHtmlViewFile({ filePath }) {
  return normalizePath(filePath).endsWith('/src/components/common/AllowedHtmlView.vue');
}

export const rule = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Disallow direct v-html outside AllowedHtmlView.',
    },
    messages: {
      noRawVHtml: 'Do not use v-html directly. Use AllowedHtmlView with AllowedHtml.',
    },
    schema: [],
  },
  create(context) {
    if (isAllowedHtmlViewFile({ filePath: context.filename ?? context.getFilename?.() ?? '' })) {
      return {};
    }

    const parserServices = context.sourceCode?.parserServices ?? context.parserServices;
    if (!parserServices?.defineTemplateBodyVisitor) {
      return {};
    }

    return parserServices.defineTemplateBodyVisitor({
      "VAttribute[directive=true][key.name.name='html']"(node) {
        context.report({ node, messageId: 'noRawVHtml' });
      },
    });
  },
};

export default {
  files: ['src/**/*.vue'],
  ignores: ['src/**/*.test.vue', 'src/**/*.spec.vue'],
  plugins: {
    'local-rules-allowed-html': {
      rules: {
        'no-raw-v-html': rule,
      },
    },
  },
  rules: {
    'local-rules-allowed-html/no-raw-v-html': 'error',
  },
};
