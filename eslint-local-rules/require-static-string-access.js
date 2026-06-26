const importSource = '@/strings';
const supportedImports = new Set(['lazyStrings', 'ensureStrings']);

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
      directArguments: 'Pass Boundary Strings parameters as one direct object literal without spreads or computed properties so production builds can compact them safely.',
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
          member?.type !== 'MemberExpression'
          || member.object !== node
          || member.computed !== false
          || member.property.type !== 'Identifier'
          || call?.type !== 'CallExpression'
          || call.callee !== member
        ) {
          context.report({
            node,
            messageId: 'directCall',
            data: { name: node.name },
          });
          return;
        }

        if (call.arguments.length === 0) {
          return;
        }
        const [argument] = call.arguments;
        if (
          call.arguments.length !== 1
          || argument?.type !== 'ObjectExpression'
          || argument.properties.some((property) => {
            return property.type === 'SpreadElement'
              || property.computed === true
              || property.type !== 'Property'
              || property.kind !== 'init'
              || property.method === true;
          })
        ) {
          context.report({
            node: call,
            messageId: 'directArguments',
          });
        }
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
