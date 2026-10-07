import { getProtectedLines, intersectsProtectedLines } from './layout-directive-safety.js';

const lineBreakPattern = /\r\n|[\n\r\u2028\u2029]/gu;
const ruleId = 'local-rules-object-layout/object-layout';

function isComment({ token }) {
  return token.type === 'Line' || token.type === 'Block';
}

// The module TEST_ONLY export is deliberately an always-vertical extension
// point, even while empty. Do not apply this exception to arbitrary bindings,
// properties named TEST_ONLY, or any objects nested inside the export.
function isModuleTestOnlyObject({ node }) {
  const declarator = node.parent;
  const declaration = declarator?.parent;
  const exported = declaration?.parent;
  return declarator?.type === 'VariableDeclarator'
    && declarator.init === node
    && declarator.id.type === 'Identifier'
    && declarator.id.name === 'TEST_ONLY'
    && declaration?.type === 'VariableDeclaration'
    && declaration.kind === 'const'
    && declaration.declare !== true
    && declaration.declarations.length === 1
    && exported?.type === 'ExportNamedDeclaration'
    && exported.parent?.type === 'Program';
}

/** @type {import('eslint').Rule.RuleModule} */
export const rule = {
  meta: {
    type: 'layout',
    docs: {
      description: 'Normalize object literals by physical line breaks, preserving always-multiline module TEST_ONLY exports.',
    },
    // Trailing commas are code, not merely whitespace.
    fixable: 'code',
    schema: [],
    messages: {
      layout: 'Normalize this object boundary (one-line objects stay on one line; multiline objects use one property per line and a trailing comma).',
      testOnlyLayout: 'Keep the module TEST_ONLY export multiline, even when empty, so test-only entries can be added vertically.',
      commentAttachment: 'Format this object manually: moving documentation comments across line breaks or commas may change their attachment.',
      directive: 'Format this object manually: a line-sensitive directive prevents safe automatic object-layout fixes.',
    },
  },
  create(context) {
    const sourceCode = context.sourceCode;
    const text = sourceCode.text;
    const defaultLineBreak = text.match(/\r\n|[\n\r\u2028\u2029]/u)?.[0] ?? '\n';
    const protectedLines = getProtectedLines({ sourceCode });
    const protectedObjects = [];

    function lineIndent({ token }) {
      return sourceCode.lines[token.loc.start.line - 1].match(/^[\t ]*/u)[0];
    }

    // Indentation is deliberately owned by Naidan's existing indent rule.
    // Preserve an existing token indent; seed new lines with two spaces. The
    // exceptions are standalone boundary comments and a value after a colon
    // comment: core indent permits/ignores those indents rather than fixing them.
    // This rule never reindents strings, template text, or comment contents.
    function whitespace({ raw, space, minimumBreaks, maximumBreaks, indent, forceIndent }) {
      const breaks = raw.match(lineBreakPattern) ?? [];
      if (minimumBreaks === 0 && breaks.length === 0) {
        return space;
      }
      const count = Math.max(minimumBreaks, Math.min(maximumBreaks, breaks.length));
      const ending = breaks[0] ?? defaultLineBreak;
      const lastBreak = breaks.at(-1);
      const existingIndent = lastBreak && !forceIndent
        ? raw.slice(raw.lastIndexOf(lastBreak) + lastBreak.length).replace(/[^\t ]/gu, '')
        : indent;
      return ending.repeat(count) + existingIndent;
    }

    // JSDoc attachment depends on trivia, not just AST structure or comment
    // text. Compare the boundary's comma/comment ordering and newline gaps,
    // treating each intact comment as opaque. Spaces and extra blank lines are
    // harmless; changing any remaining gap is deliberately manual-only.
    function boundaryEdit({ left, right, replacement, comments }) {
      const range = [left.range[1], right.range[0]];
      const original = text.slice(...range);
      function signature({ content }) {
        const parts = [];
        let offset = 0;
        function gap({ raw }) {
          return raw.replace(/[^\S\r\n\u2028\u2029]/gu, '')
            .replace(/(\r\n|[\n\r\u2028\u2029])\1+/gu, '$1');
        }
        for (const comment of comments) {
          const raw = sourceCode.getText(comment);
          const index = content.indexOf(raw, offset);
          if (index < 0) {
            return undefined;
          }
          parts.push(gap({ raw: content.slice(offset, index) }));
          offset = index + raw.length;
        }
        parts.push(gap({ raw: content.slice(offset) }));
        return JSON.stringify(parts);
      }
      const hasDocumentation = comments.some(comment => comment.type === 'Block' && comment.value.startsWith('*'));
      const replacementSignature = hasDocumentation ? signature({ content: replacement }) : undefined;
      return {
        range,
        text: replacement,
        changesDocumentationLayout: hasDocumentation
          && (replacementSignature === undefined || signature({ content: original }) !== replacementSignature),
      };
    }

    // The whole replacement range is an owned boundary: whitespace, comments,
    // and at most the object's separator comma. It never contains a property
    // expression. Keeping boundaries separate avoids locking nested objects
    // out of ESLint's limited number of automatic fix passes.
    function boundary({ left, right, mode, comma, indent, closingIndent }) {
      const middle = sourceCode.getTokensBetween(left, right, { includeComments: true });
      const punctuation = middle.filter(token => !isComment({ token }));
      if (punctuation.some(token => token.value !== ',') || punctuation.length > 1) {
        return undefined;
      }
      if ((mode === 'open' || mode === 'empty') && punctuation.length > 0) {
        return undefined;
      }
      const separator = punctuation[0];
      const comments = middle.filter(token => isComment({ token }));
      function gap({ start, end }) {
        if (separator && separator.range[0] >= start && separator.range[1] <= end) {
          return text.slice(start, separator.range[0]) + text.slice(separator.range[1], end);
        }
        return text.slice(start, end);
      }

      const multiline = mode !== 'inline';
      let result = comma ? ',' : '';
      let previous = left;
      for (const comment of comments) {
        const raw = gap({ start: previous.range[1], end: comment.range[0] });
        const afterOpening = previous === left && (mode === 'open' || mode === 'empty');
        result += multiline
          ? whitespace({
            raw,
            space: ' ',
            minimumBreaks: afterOpening || previous.type === 'Line' ? 1 : 0,
            maximumBreaks: afterOpening ? 1 : 2,
            indent,
            forceIndent: true,
          })
          : ' ';
        result += sourceCode.getText(comment);
        previous = comment;
      }
      const raw = gap({ start: previous.range[1], end: right.range[0] });
      const closing = mode === 'close' || mode === 'empty';
      result += multiline
        ? whitespace({
          raw,
          space: ' ',
          minimumBreaks: 1,
          maximumBreaks: closing || (mode === 'open' && comments.length === 0) ? 1 : 2,
          indent: closing ? closingIndent : indent,
          forceIndent: false,
        })
        : ' ';
      return boundaryEdit({ left, right, replacement: result, comments });
    }

    function colonBoundary({ left, right, space, indent }) {
      const middle = sourceCode.getTokensBetween(left, right, { includeComments: true });
      if (middle.some(token => !isComment({ token }))) {
        return undefined;
      }
      // With no comments, even a manually wrapped colon is normalized. The
      // object's multiline decision was made before planning any of its edits.
      if (middle.length === 0) {
        return { range: [left.range[1], right.range[0]], text: space };
      }
      let result = '';
      let previous = left;
      for (const comment of middle) {
        result += whitespace({
          raw: text.slice(previous.range[1], comment.range[0]),
          space: ' ',
          minimumBreaks: previous.type === 'Line' ? 1 : 0,
          maximumBreaks: 2,
          indent,
          forceIndent: true,
        });
        result += sourceCode.getText(comment);
        previous = comment;
      }
      result += whitespace({
        raw: text.slice(previous.range[1], right.range[0]),
        space,
        minimumBreaks: previous.type === 'Line' ? 1 : 0,
        maximumBreaks: 2,
        indent,
        forceIndent: true,
      });
      return boundaryEdit({ left, right, replacement: result, comments: middle });
    }

    function planObject({ node }) {
      const opening = sourceCode.getFirstToken(node);
      const closing = sourceCode.getLastToken(node);
      if (opening?.value !== '{' || closing?.value !== '}') {
        return [];
      }
      const testOnly = isModuleTestOnlyObject({ node });
      const multiline = testOnly || node.loc.start.line !== node.loc.end.line;
      const closingIndent = lineIndent({ token: opening });
      const indent = closingIndent + '  ';
      const edits = [];
      function add({ edit }) {
        if (edit && text.slice(...edit.range) !== edit.text) {
          edits.push(edit);
        }
      }
      if (node.properties.length === 0) {
        const inside = sourceCode.getTokensBetween(opening, closing, { includeComments: true });
        if (inside.length === 0) {
          const raw = text.slice(opening.range[1], closing.range[0]);
          add({ edit: {
            range: [opening.range[1], closing.range[0]],
            text: testOnly
              ? whitespace({ raw, space: '', minimumBreaks: 1, maximumBreaks: 1, indent: closingIndent, forceIndent: false })
              : '',
          } });
        } else {
          add({ edit: boundary({
            left: opening, right: closing, mode: multiline ? 'empty' : 'inline',
            comma: false, indent, closingIndent,
          }) });
        }
        return edits;
      }

      let previous = opening;
      for (const property of node.properties) {
        const first = sourceCode.getFirstToken(property);
        const last = sourceCode.getLastToken(property);
        add({ edit: boundary({
          left: previous, right: first,
          mode: multiline ? (previous === opening ? 'open' : 'between') : 'inline',
          comma: previous !== opening, indent, closingIndent,
        }) });
        if (property.type === 'Property' && !property.method && !property.shorthand && property.kind === 'init') {
          // Looking only between key and value avoids colons in computed keys,
          // ternaries, methods, type arguments, strings, and nested objects.
          const colon = sourceCode.getTokensBetween(property.key, property.value).find(token => token.value === ':');
          if (colon) {
            add({ edit: colonBoundary({ left: sourceCode.getTokenBefore(colon), right: colon, space: '', indent }) });
            add({ edit: colonBoundary({ left: colon, right: sourceCode.getTokenAfter(colon), space: ' ', indent }) });
          }
        }
        previous = last;
      }
      add({ edit: boundary({
        left: previous, right: closing, mode: multiline ? 'close' : 'inline',
        comma: multiline, indent, closingIndent,
      }) });
      return edits;
    }

    return {
      ObjectExpression(node) {
        const edits = planObject({ node });
        const protectedReason = protectedObjects.at(-1)
          ?? (intersectsProtectedLines({ node, intervals: protectedLines }) ? 'directive' : undefined)
          ?? (edits.some(edit => edit.changesDocumentationLayout) ? 'commentAttachment' : undefined);
        protectedObjects.push(protectedReason);
        if (protectedReason) {
          if (edits.length > 0) {
            context.report({ node, messageId: protectedReason });
          }
          return;
        }
        for (const edit of edits) {
          context.report({
            loc: {
              start: sourceCode.getLocFromIndex(edit.range[0]),
              end: sourceCode.getLocFromIndex(edit.range[1]),
            },
            messageId: isModuleTestOnlyObject({ node }) ? 'testOnlyLayout' : 'layout',
            fix(fixer) {
              return fixer.replaceTextRange(edit.range, edit.text);
            },
          });
        }
      },
      'ObjectExpression:exit'() {
        protectedObjects.pop();
      },
    };
  },
};

export default {
  // Match Naidan's existing script-formatting scope. Vue template expressions,
  // object patterns, type literals, import/export braces, and blocks are not
  // visited as script ObjectExpressions by this rule.
  files: ['**/*.ts', '**/*.vue'],
  plugins: {
    'local-rules-object-layout': {
      rules: { 'object-layout': rule },
    },
  },
  rules: { [ruleId]: 'error' },
};
