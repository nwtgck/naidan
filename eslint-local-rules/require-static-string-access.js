const importSource = '@/strings';
const supportedImports = new Set(['strings', 'stringsAsync']);

export const rule = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Require Boundary Strings calls to use direct static member access.',
    },
    schema: [],
    messages: {
      directCall: 'Call Boundary Strings as {{name}}.<static_key>(...) so Vite can discover the message dependency.',
      noAlias: 'Import {{name}} without an alias so Boundary Strings analysis can identify it.',
    },
  },
  create(context) {
    const importedBindings = new Set();
    const invalidAliasedBindings = new Set();

    return {
      ImportDeclaration(node) {
        if (node.source.value !== importSource) {
          return;
        }
        for (const specifier of node.specifiers) {
          if (specifier.type !== 'ImportSpecifier') {
            continue;
          }
          const importedName = specifier.imported.type === 'Identifier'
            ? specifier.imported.name
            : specifier.imported.value;
          if (!supportedImports.has(importedName)) {
            continue;
          }
          importedBindings.add(specifier.local.name);
          if (specifier.local.name !== importedName) {
            invalidAliasedBindings.add(specifier.local.name);
            context.report({
              node: specifier,
              messageId: 'noAlias',
              data: { name: importedName },
            });
          }
        }
      },
      Identifier(node) {
        if (!importedBindings.has(node.name)) {
          return;
        }
        if (node.parent?.type === 'ImportSpecifier') {
          return;
        }
        if (invalidAliasedBindings.has(node.name)) {
          context.report({
            node,
            messageId: 'directCall',
            data: { name: node.name },
          });
          return;
        }
        const member = node.parent;
        const call = member?.parent;
        if (
          member?.type === 'MemberExpression'
          && member.object === node
          && member.computed === false
          && member.property.type === 'Identifier'
          && call?.type === 'CallExpression'
          && call.callee === member
        ) {
          return;
        }
        context.report({
          node,
          messageId: 'directCall',
          data: { name: node.name },
        });
      },
    };
  },
};

export default {
  files: ['src/**/*.ts', 'src/**/*.vue'],
  ignores: ['src/**/*.test.ts', 'src/**/*.spec.ts', 'src/strings/**/*.ts'],
  plugins: {
    'local-rules-boundary-strings': {
      rules: {
        'require-static-string-access': rule,
      },
    },
  },
  rules: {
    'local-rules-boundary-strings/require-static-string-access': 'error',
  },
};
