import { ESLintUtils } from '@typescript-eslint/utils';
import * as ts from 'typescript';

const createRule = ESLintUtils.RuleCreator(
  (name) => `https://github.com/example/project/blob/main/rules/${name}.md`
);

export const rule = createRule({
  name: 'force-switch-for-union',
  meta: {
    type: 'suggestion',
    docs: {
      description: 'Enforce switch statements for string literal union type checks to ensure exhaustiveness',
    },
    messages: {
      preferSwitch: `Use a switch statement with an exhaustive never check for union types instead of if/ternary.
This ensures that all cases are handled when the union type is expanded.
Consider using an IIFE if you need to assign the result:

const result = (() => {
  switch (type) {
    case "a": return "value1";
    case "b": return "value2";
    default: {
      const _ex: never = type;
      throw new Error(\`Unhandled case: \${_ex}\`);
    }
  }
})();`,
    },
    schema: [],
  },
  defaultOptions: [],
  create(context) {
    const parserServices = ESLintUtils.getParserServices(context);
    const checker = parserServices.program.getTypeChecker();

    function check(test) {
      if (
        test.type !== 'BinaryExpression' ||
        !['===', '==', '!==', '!='].includes(test.operator)
      ) {
        return;
      }

      const { left, right } = test;
      const isLeftStringLiteral = (left.type === 'Literal' && typeof left.value === 'string') ||
                                   (left.type === 'TemplateLiteral' && left.quasis.length === 1 && left.expressions.length === 0);
      const isRightStringLiteral = (right.type === 'Literal' && typeof right.value === 'string') ||
                                    (right.type === 'TemplateLiteral' && right.quasis.length === 1 && right.expressions.length === 0);

      if (isLeftStringLiteral === isRightStringLiteral) return;

      const targetNode = isLeftStringLiteral ? right : left;
      const originalNode = parserServices.esTreeNodeToTSNodeMap.get(targetNode);
      const type = checker.getTypeAtLocation(originalNode);

      // Check if it's a union type
      if (type.isUnion()) {
        // Ensure all members of the union are string literals
        const isStringLiteralUnion = type.types.every((t) => {
          return t.isStringLiteral() || (t.getFlags() & ts.TypeFlags.StringLiteral);
        });

        if (isStringLiteralUnion) {
          context.report({
            node: test,
            messageId: 'preferSwitch',
          });
        }
      }
    }

    return {
      IfStatement(node) {
        check(node.test);
      },
      ConditionalExpression(node) {
        check(node.test);
      }
    };
  },
});

export default {
  files: ['**/*.ts', '**/*.vue'],
  plugins: {
    'local-rules-switch': {
      rules: {
        'force-switch-for-union': rule
      }
    }
  },
  rules: {
    'local-rules-switch/force-switch-for-union': 'error'
  }
};
