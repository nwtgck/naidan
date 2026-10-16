import { builtinRules } from 'eslint/use-at-your-own-risk';
import { getProtectedLines, intersectsProtectedLines } from './layout-directive-safety.js';

const ruleId = 'local-rules-statement-layout/statement-layout';
const curlyRule = builtinRules.get('curly');
const braceStyleRule = builtinRules.get('brace-style');
const indentRule = builtinRules.get('indent');
const trailingSpacesRule = builtinRules.get('no-trailing-spaces');
const statementListParents = new Set(['Program', 'BlockStatement', 'StaticBlock', 'SwitchCase']);

if (!curlyRule || !braceStyleRule || !indentRule || !trailingSpacesRule) {
  throw new Error('Statement layout requires the ESLint curly, brace-style, indent, and no-trailing-spaces rules.');
}

function tokensAndComments({ sourceCode }) {
  // Program.range can omit leading/trailing comments, so getTokens with
  // includeComments alone cannot protect all original comment content.
  return [...sourceCode.getTokens(sourceCode.ast), ...sourceCode.getAllComments()]
    .sort((left, right) => left.range[0] - right.range[0]);
}

function safeWhitespaceRule({ base }) {
  return {
    ...base,
    meta: { ...base.meta, deprecated: undefined },
    create(context) {
      const sourceCode = context.sourceCode;
      const tokens = tokensAndComments({ sourceCode });
      const scriptRanges = sourceCode.parserServices.getDocumentFragment?.()?.children
        .filter(node => node.type === 'VElement' && node.name === 'script' && node.endTag)
        .map(node => [node.startTag.range[1], node.endTag.range[0]]);

      function insideSourceWhitespace({ range }) {
        if (scriptRanges && !scriptRanges.some(([start, end]) => start <= range[0] && range[1] <= end)) {
          return false;
        }
        let low = 0;
        let high = tokens.length;
        while (low < high) {
          const middle = Math.floor((low + high) / 2);
          if (tokens[middle].range[1] < range[0]) {
            low = middle + 1;
          } else {
            high = middle;
          }
        }
        for (let index = low; index < tokens.length && tokens[index].range[0] <= range[1]; index += 1) {
          const token = tokens[index];
          // JSX text owns boundary whitespace too: inserting at the closing
          // tag's start can append characters to the preceding JSXText value.
          if (token.type === 'JSXText'
            || (token.range[0] < range[1] && range[0] < token.range[1])) {
            return false;
          }
        }
        return true;
      }

      return base.create(Object.create(context, {
        report: {
          value(descriptor) {
            const range = [sourceCode.getIndexFromLoc(descriptor.loc.start), sourceCode.getIndexFromLoc(descriptor.loc.end)];
            // Whitespace inside a literal, JSX text, or comment is its content,
            // so it is neither a layout violation nor an automatic fix target.
            if (insideSourceWhitespace({ range })) {
              context.report(descriptor);
            }
          },
        },
      }));
    },
  };
}

/** @type {import('eslint').Rule.RuleModule} */
export const rule = {
  meta: {
    type: 'layout',
    docs: {
      description: 'Separate independent statements and require multiline control blocks without changing line-sensitive directives.',
    },
    fixable: 'code',
    schema: [],
    messages: {
      ...curlyRule.meta.messages,
      ...braceStyleRule.meta.messages,
      separate: 'Put this independent statement on a separate line.',
      manual: 'Format this statement boundary manually: a directive or documentation comment prevents safe automatic changes.',
    },
  },
  create(context) {
    const sourceCode = context.sourceCode;
    const text = sourceCode.text;
    let newline;
    let previousEnd = 0;
    for (const token of tokensAndComments({ sourceCode })) {
      const match = /\r\n|[\n\r\u2028\u2029]/u.exec(text.slice(previousEnd, token.range[0]));
      if (match) {
        newline = match[0];
        break;
      }
      previousEnd = token.range[1];
    }
    newline ??= /\r\n|[\n\r\u2028\u2029]/u.exec(text.slice(previousEnd))?.[0] ?? '\n';
    const protectedLines = [];
    const intervals = [
      ...getProtectedLines({ sourceCode }),
      ...sourceCode.getAllComments()
        .filter(comment => comment.type === 'Block' && comment.value.startsWith('*'))
        .map(comment => ({ start: comment.loc.start.line, end: comment.loc.end.line })),
    ].sort((left, right) => left.start - right.start);
    for (const interval of intervals) {
      const previous = protectedLines.at(-1);
      if (previous && interval.start <= previous.end + 1) {
        previous.end = Math.max(previous.end, interval.end);
      } else {
        protectedLines.push({ ...interval });
      }
    }
    // Vue merges script and script setup into a Program. Its source gaps also
    // contain template/style text, which must never become statement spacing.
    const scriptRanges = sourceCode.parserServices.getDocumentFragment?.()?.children
      .filter(node => node.type === 'VElement' && node.name === 'script' && node.endTag)
      .map(node => [node.startTag.range[1], node.endTag.range[0]]);

    function sameScript({ left, right }) {
      return !scriptRanges || scriptRanges.some(([start, end]) => left.range[0] >= start && right.range[1] <= end);
    }

    function protectedRange({ range }) {
      return intersectsProtectedLines({
        node: { loc: { start: sourceCode.getLocFromIndex(range[0]), end: sourceCode.getLocFromIndex(range[1]) } },
        intervals: protectedLines,
      });
    }

    function unsafeControlBody({ node, loc }) {
      const bodies = node.type === 'IfStatement' ? [node.consequent, node.alternate] : [node.body];
      let body = bodies.find(candidate => candidate?.loc.start.line === loc?.start.line
        && candidate.loc.start.column === loc.start.column);
      // Inserting the opening brace after a leading annotation would detach
      // it from the body expression (for example a bundler PURE annotation).
      if (body && sourceCode.getCommentsBefore(body).length > 0) {
        return true;
      }
      while (body?.type === 'LabeledStatement') {
        body = body.body;
      }
      // Annex B function declarations can change their hoisting/visibility
      // when a new lexical block is introduced in a non-strict script.
      return body?.type === 'FunctionDeclaration';
    }

    function delegate({ base, options, control }) {
      const delegatedContext = Object.create(context, {
        options: { value: options },
        report: {
          value(descriptor) {
            const originalFix = descriptor.fix;
            context.report({
              ...descriptor,
              fix: !originalFix || (control && unsafeControlBody({ node: descriptor.node, loc: descriptor.loc }))
                ? undefined
                : fixer => {
                  const proposal = originalFix(fixer);
                  if (!proposal) {
                    return undefined;
                  }
                  const fixes = Array.isArray(proposal) ? proposal : [proposal];
                  if (fixes.some(fix => protectedRange({ range: fix.range }))) {
                    return undefined;
                  }
                  // Curly copies the original body, including literals and
                  // comments. Only brace-style creates new newline whitespace.
                  return control ? fixes : fixes.map(fix => ({
                    ...fix, text: fix.text.replace(/\r\n|[\n\r\u2028\u2029]/gu, newline),
                  }));
                },
            });
          },
        },
      });
      return base.create(delegatedContext);
    }

    function boundary({ previous, next }) {
      if (previous.loc.end.line !== next.loc.start.line || !sameScript({ left: previous, right: next })) {
        return;
      }
      const left = sourceCode.getLastToken(previous);
      const right = sourceCode.getFirstToken(next);
      const comments = sourceCode.getTokensBetween(left, right, { includeComments: true });
      if (comments.some(token => token.type !== 'Block' && token.type !== 'Line')) {
        return;
      }
      const last = comments.at(-1) ?? left;
      const range = [last.range[1], right.range[0]];
      if (/\S/u.test(text.slice(...range))) {
        return;
      }
      const unsafe = protectedRange({ range: [left.range[1], right.range[0]] })
        || comments.some(comment => comment.type === 'Block' && comment.value.startsWith('*'));
      context.report({
        node: next,
        messageId: unsafe ? 'manual' : 'separate',
        fix: unsafe ? undefined : fixer => fixer.replaceTextRange(range, newline + indentation({ node: next })),
      });
    }

    function indentation({ node }) {
      if (node.parent.type !== 'TSModuleBlock') {
        return '';
      }
      const line = sourceCode.lines[node.parent.loc.start.line - 1];
      return /^\s*/u.exec(line)[0] + '  ';
    }

    function statements({ body }) {
      let previous;
      for (const next of body) {
        // Empty semicolons remain attached to the preceding statement. They
        // do not create independent, otherwise empty lines during formatting.
        if (next.type === 'EmptyStatement') {
          if (previous) {
            previous = next;
          }
          continue;
        }
        if (previous) {
          boundary({ previous, next });
        }
        previous = next;
      }
    }

    function supplementaryBlock({ node }) {
      const first = sourceCode.getFirstToken(node);
      const last = sourceCode.getLastToken(node);
      const after = sourceCode.getTokenAfter(first);
      const before = sourceCode.getTokenBefore(last);
      if (after === last) {
        return;
      }
      for (const [left, right, messageId] of [
        [first, after, 'blockSameLine'],
        [before, last, 'singleLineClose'],
      ]) {
        if (left.loc.end.line !== right.loc.start.line) {
          continue;
        }
        const offset = messageId === 'blockSameLine' ? left.range[1] : right.range[0];
        context.report({
          node: messageId === 'blockSameLine' ? first : last,
          messageId,
          fix: protectedRange({ range: [offset, offset] }) ? undefined
            : fixer => {
              const base = /^\s*/u.exec(sourceCode.lines[node.loc.start.line - 1])[0];
              const indent = messageId === 'blockSameLine' ? base + '  ' : base;
              const end = messageId === 'blockSameLine' ? sourceCode.getTokenAfter(first, { includeComments: true }).range[0] : offset;
              return fixer.replaceTextRange([offset, end], newline + indent);
            },
        });
      }
    }

    const own = {
      Program(node) {
        statements({ body: node.body });
      },
      BlockStatement(node) {
        statements({ body: node.body });
        if (statementListParents.has(node.parent.type)) {
          supplementaryBlock({ node });
        }
      },
      StaticBlock(node) {
        statements({ body: node.body });
      },
      TSModuleBlock(node) {
        statements({ body: node.body });
        supplementaryBlock({ node });
      },
      SwitchCase(node) {
        statements({ body: node.consequent });
      },
      SwitchStatement(node) {
        for (let index = 1; index < node.cases.length; index += 1) {
          const previous = node.cases[index - 1].consequent.at(-1);
          if (previous) {
            boundary({ previous, next: node.cases[index] });
          }
        }
      },
    };
    const visitors = [
      delegate({ base: curlyRule, options: ['all'], control: true }),
      delegate({ base: braceStyleRule, options: ['1tbs', { allowSingleLine: false }], control: false }),
      own,
    ];
    const merged = {};
    for (const visitor of visitors) {
      for (const [selector, listener] of Object.entries(visitor)) {
        const previous = merged[selector];
        merged[selector] = previous ? node => {
          previous(node);
          listener(node);
        } : listener;
      }
    }
    return merged;
  },
};

export default {
  name: 'naidan/statement-layout',
  files: ['**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts,vue}'],
  plugins: {
    'local-rules-statement-layout': {
      rules: {
        'statement-layout': rule,
        'indent': safeWhitespaceRule({ base: indentRule }),
        'no-trailing-spaces': safeWhitespaceRule({ base: trailingSpacesRule }),
      },
    },
  },
  rules: {
    'brace-style': 'off',
    'indent': 'off',
    'no-trailing-spaces': 'off',
    'local-rules-statement-layout/indent': ['warn', 2],
    'local-rules-statement-layout/no-trailing-spaces': 'error',
    [ruleId]: 'error',
  },
};
