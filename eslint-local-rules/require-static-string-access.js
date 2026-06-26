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
    const importedVariables = [];

    function validateReference({ canonicalName, identifier, isAliased }) {
      if (isAliased) {
        context.report({
          node: identifier,
          messageId: 'directCall',
          data: { name: identifier.name },
        });
        return;
      }
      const member = identifier.parent;
      const call = member?.parent;
      if (
        member?.type !== 'MemberExpression'
        || member.object !== identifier
        || member.computed !== false
        || member.property.type !== 'Identifier'
        || call?.type !== 'CallExpression'
        || call.callee !== member
      ) {
        context.report({
          node: identifier,
          messageId: 'directCall',
          data: { name: canonicalName },
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
    }

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
          const variable = context.sourceCode.getDeclaredVariables(specifier).find((candidate) => {
            return candidate.name === specifier.local.name;
          });
          if (variable === undefined) {
            throw new Error(`Failed to resolve Boundary Strings import ${specifier.local.name}.`);
          }
          const isAliased = specifier.local.name !== importedName;
          importedVariables.push({
            canonicalName: importedName,
            isAliased,
            variable,
          });
          if (isAliased) {
            context.report({
              node: specifier,
              messageId: 'noAlias',
              data: { name: importedName },
            });
          }
        }
      },
      'Program:exit'() {
        for (const imported of importedVariables) {
          for (const reference of imported.variable.references) {
            if (reference.identifier.parent?.type === 'ImportSpecifier') {
              continue;
            }
            validateReference({
              canonicalName: imported.canonicalName,
              identifier: reference.identifier,
              isAliased: imported.isAliased,
            });
          }
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
