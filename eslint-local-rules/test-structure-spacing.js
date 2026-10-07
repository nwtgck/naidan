const declarationKinds = new Map([
  ['describe', 'suite'],
  ['suite', 'suite'],
  ['it', 'test'],
  ['test', 'test'],
  ['beforeAll', 'hook'],
  ['beforeEach', 'hook'],
  ['afterAll', 'hook'],
  ['afterEach', 'hook'],
]);
const modifiers = new Set(['skip', 'only', 'todo', 'concurrent', 'sequential', 'fails', 'shuffle']);
const factories = new Set(['each', 'for', 'skipIf', 'runIf']);

function unwrapExpression({ node }) {
  while (node && [
    'TSAsExpression',
    'TSSatisfiesExpression',
    'TSTypeAssertion',
    'TSNonNullExpression',
    'TSInstantiationExpression',
  ].includes(node.type)) {
    node = node.expression;
  }
  return node;
}

function getPropertyName({ node }) {
  if (!node.computed && node.property.type === 'Identifier') {
    return node.property.name;
  }
  if (node.computed && node.property.type === 'Literal' && typeof node.property.value === 'string') {
    return node.property.value;
  }
  return undefined;
}

/** @type {import('eslint').Rule.RuleModule} */
export const rule = {
  meta: {
    type: 'layout',
    docs: {
      description: 'Separate Vitest declarations with one blank line without padding callback bodies.',
    },
    fixable: 'whitespace',
    schema: [],
    messages: {
      siblingSpacing: 'Use exactly one blank line around a test, suite, or lifecycle hook declaration.',
      callbackPadding: 'Do not add blank lines at the start or end of a test, suite, or lifecycle hook callback.',
    },
  },
  create(context) {
    const sourceCode = context.sourceCode;
    const text = sourceCode.text;
    const defaultNewline = text.match(/\r\n|[\n\r\u2028\u2029]/u)?.[0] ?? '\n';
    const declarations = new WeakMap();

    function resolveIdentifier({ node }) {
      let scope = sourceCode.getScope(node);
      while (scope) {
        const variable = scope.set.get(node.name);
        if (variable) {
          if (variable.defs.length === 0) {
            const kind = declarationKinds.get(node.name);
            return kind ? { kind, stage: 'declaration' } : undefined;
          }
          if (variable.defs.length !== 1) return undefined;
          const definition = variable.defs[0];
          if (
            definition.type !== 'ImportBinding' ||
            definition.parent.source.value !== 'vitest' ||
            definition.parent.importKind === 'type' ||
            definition.node.importKind === 'type'
          ) return undefined;
          if (definition.node.type === 'ImportNamespaceSpecifier') {
            return { kind: 'namespace', stage: 'declaration' };
          }
          if (definition.node.type !== 'ImportSpecifier') return undefined;
          const imported = definition.node.imported;
          const kind = declarationKinds.get(imported.name ?? imported.value);
          return kind ? { kind, stage: 'declaration' } : undefined;
        }
        scope = scope.upper;
      }
      const kind = declarationKinds.get(node.name);
      return kind ? { kind, stage: 'declaration' } : undefined;
    }

    function getCallable({ node }) {
      node = unwrapExpression({ node });
      if (!node || node.optional) return undefined;
      if (node.type === 'Identifier') return resolveIdentifier({ node });
      if (node.type === 'MemberExpression') {
        const owner = getCallable({ node: node.object });
        if (!owner || owner.stage !== 'declaration') return undefined;
        const name = getPropertyName({ node });
        if (owner.kind === 'namespace') {
          const kind = declarationKinds.get(name);
          return kind ? { kind, stage: 'declaration' } : undefined;
        }
        if (owner.kind === 'hook') return undefined;
        if (modifiers.has(name)) return owner;
        if (factories.has(name)) return { kind: owner.kind, stage: name };
        return undefined;
      }
      if (node.type === 'CallExpression' || node.type === 'TaggedTemplateExpression') {
        const callee = getCallable({ node: node.type === 'CallExpression' ? node.callee : node.tag });
        if (!callee || !factories.has(callee.stage)) return undefined;
        if (node.type === 'TaggedTemplateExpression' && callee.stage !== 'each') return undefined;
        return { kind: callee.kind, stage: 'declaration' };
      }
      return undefined;
    }

    function getDeclaration({ call }) {
      if (call?.type !== 'CallExpression' || call.optional) return undefined;
      if (declarations.has(call)) return declarations.get(call);
      const callable = getCallable({ node: call.callee });
      const result = callable?.stage === 'declaration' && callable.kind !== 'namespace'
        ? { call, kind: callable.kind }
        : undefined;
      declarations.set(call, result);
      return result;
    }

    function getStatementDeclaration({ statement }) {
      return statement.type === 'ExpressionStatement'
        ? getDeclaration({ call: unwrapExpression({ node: statement.expression }) })
        : undefined;
    }

    function checkGap({ left, right, node, lineBreaks, messageId }) {
      const range = [left.range[1], right.range[0]];
      const gap = text.slice(...range);
      // Edit only whitespace between complete syntax nodes, never comments or literal contents.
      if (/\S/u.test(gap)) return;
      const breaks = gap.match(/\r\n|[\n\r\u2028\u2029]/gu) ?? [];
      if (breaks.length === lineBreaks || (lineBreaks === 1 && breaks.length === 0)) return;
      const newline = breaks[0] ?? defaultNewline;
      const indentation = breaks.length > 0
        ? gap.slice(gap.lastIndexOf(breaks.at(-1)) + breaks.at(-1).length)
        : (sourceCode.lines[right.loc.start.line - 1].match(/^[\t ]*/u)?.[0] ?? '');
      context.report({
        node,
        loc: right.loc,
        messageId,
        fix(fixer) {
          return fixer.replaceTextRange(range, newline.repeat(lineBreaks) + indentation);
        },
      });
    }

    function checkCallback({ declaration }) {
      const callback = declaration.call.arguments
        .slice(declaration.kind === 'hook' ? 0 : 1)
        .map(node => unwrapExpression({ node }))
        .find(node => (
          (node?.type === 'ArrowFunctionExpression' || node?.type === 'FunctionExpression') &&
          node.body.type === 'BlockStatement'
        ));
      if (!callback) return;
      const body = callback.body;
      const open = sourceCode.getFirstToken(body);
      const close = sourceCode.getLastToken(body);
      if (body.body.length === 0) {
        checkGap({ left: open, right: close, node: body, lineBreaks: 1, messageId: 'callbackPadding' });
        return;
      }
      checkGap({ left: open, right: body.body[0], node: body, lineBreaks: 1, messageId: 'callbackPadding' });
      checkGap({ left: body.body.at(-1), right: close, node: body, lineBreaks: 1, messageId: 'callbackPadding' });
    }

    function checkStatements({ statements }) {
      for (let index = 1; index < statements.length; index += 1) {
        const statement = statements[index];
        const previous = statements[index - 1];
        if (!getStatementDeclaration({ statement }) && !getStatementDeclaration({ statement: previous })) continue;
        checkGap({ left: previous, right: statement, node: statement, lineBreaks: 2, messageId: 'siblingSpacing' });
      }
    }

    return {
      'CallExpression:exit'(node) {
        const declaration = getDeclaration({ call: node });
        if (declaration) checkCallback({ declaration });
      },
      'Program:exit'(node) {
        checkStatements({ statements: node.body });
      },
      'BlockStatement:exit'(node) {
        checkStatements({ statements: node.body });
      },
      'SwitchCase:exit'(node) {
        checkStatements({ statements: node.consequent });
      },
    };
  },
};

/** @type {import('eslint').Linter.Config} */
const config = {
  files: ['**/*.{test,spec}.{js,jsx,mjs,cjs,ts,tsx,mts,cts}'],
  plugins: {
    'local-rules-test-layout': {
      rules: {
        'test-structure-spacing': rule,
      },
    },
  },
  rules: {
    'local-rules-test-layout/test-structure-spacing': 'error',
    'comma-spacing': ['error', { before: false, after: true }],
    'arrow-spacing': ['error', { before: true, after: true }],
    'space-before-function-paren': ['error', { anonymous: 'ignore', named: 'ignore', asyncArrow: 'always' }],
  },
};

export default config;
