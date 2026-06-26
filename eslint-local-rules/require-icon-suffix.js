
export const rule = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Enforce "Icon" suffix for icons imported from lucide-vue-next',
    },
    messages: {
      requireIconSuffix: 'Icon names imported from lucide-vue-next must end with "Icon". (e.g., import { {{imported}}Icon } from "lucide-vue-next")',
    },
    schema: [],
  },
  create(context) {
    return {
      ImportDeclaration(node) {
        if (node.source.value !== 'lucide-vue-next') return;

        node.specifiers.forEach((specifier) => {
          if (specifier.type === 'ImportSpecifier') {
            const localName = specifier.local.name;
            const importedName = specifier.imported.name;

            // If it already ends with Icon, it's correct
            if (localName.endsWith('Icon')) return;

            context.report({
              node: specifier,
              messageId: 'requireIconSuffix',
              data: {
                imported: importedName,
              },
            });
          }
        });
      },
    };
  },
};

export default {
  files: ['**/*.ts', '**/*.vue'],
  plugins: {
    'local-rules-lucide': {
      rules: {
        'require-icon-suffix': rule,
      },
    },
  },
  rules: {
    'local-rules-lucide/require-icon-suffix': 'error',
  },
};
