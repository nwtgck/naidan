import cssParser, { parseStylesheet, syntaxErrorOffset } from './css-layout-parser.js';

const ruleId = 'local-rules-css-layout/css-layout';
const newlinePattern = /\r\n|[\n\r]/gu;
const whitespacePattern = /^[\t\n\f\r ]*$/u;

function rawValue({ node, field }) {
  return node.raws[field]?.raw ?? node[field];
}

function blockOpening({ node }) {
  const header = node.type === 'rule'
    ? rawValue({ node, field: 'selector' })
    : `@${node.name}${node.raws.afterName ?? ''}${rawValue({ node, field: 'params' })}`;
  return node.source.start.offset + header.length + node.raws.between.length;
}

function blockRange({ node, css }) {
  const opening = blockOpening({ node });
  const suffix = node.raws.ownSemicolon ?? '';
  // PostCSS can count the whitespace before a rule's own semicolon twice in
  // source.end.offset. Validate both positions against the original bytes.
  const closing = [node.source.end.offset - suffix.length - 1, node.source.end.offset - 2 * suffix.length]
    .find(index => css[index] === '}' && css.slice(index + 1, index + 1 + suffix.length) === suffix);
  if (css[opening] !== '{' || closing === undefined) {
    return undefined;
  }
  return { opening, closing, end: closing + 1 + suffix.length };
}

function declarationRange({ node, css }) {
  const start = node.source.start.offset;
  // PostCSS keeps legacy property hacks in raws.before, outside node.prop.
  const hack = ['*', '_'].includes(css[start]) && css.slice(start + 1, start + 1 + node.prop.length) === node.prop
    ? css[start] : '';
  const propEnd = start + hack.length + node.prop.length;
  const raw = `${hack}${node.prop}${node.raws.between}${rawValue({ node, field: 'value' })}${node.important ? node.raws.important ?? ' !important' : ''}`;
  if (css.slice(start, start + raw.length) !== raw) {
    return undefined;
  }
  return { propEnd, end: start + raw.length };
}

function layoutEdits({ root, css, newline, embedded }) {
  const edits = [];

  function replace({ start, end, text }) {
    if (css.slice(start, end) !== text) {
      edits.push({ start, end, text });
    }
  }

  function gap({ start, end, depth, mode }) {
    const original = css.slice(start, end);
    if (!whitespacePattern.test(original)) {
      // CSS permits empty declarations. Keep their semicolons intact, but
      // still put the following declaration/closing brace on its own line.
      if (/^[\t\n\f\r ;]*$/u.test(original)) {
        gap({ start: start + original.lastIndexOf(';') + 1, end, depth, mode: mode === 'leading' ? 'line' : mode });
      }
      return;
    }
    const breaks = original.match(newlinePattern) ?? [];
    const indentation = '  '.repeat(depth);
    const text = mode === 'inline' && breaks.length === 0 ? ' '
      : breaks.length > 0 ? `${breaks.join('')}${indentation}`
        : mode === 'leading' ? indentation
          : `${newline}${indentation}`;
    replace({ start, end, text });
  }

  function visit({ container, depth, opening, closing }) {
    let cursor = opening === undefined ? 0 : opening + 1;
    let previous;
    for (const node of container.nodes) {
      const start = node.source.start.offset;
      gap({
        start: cursor, end: start, depth,
        mode: node.type === 'comment' && previous ? 'inline'
          : opening === undefined && !previous && !embedded ? 'leading' : 'line',
      });
      if (node.nodes) {
        const range = blockRange({ node, css });
        if (range) {
          const betweenStart = range.opening - node.raws.between.length;
          if (whitespacePattern.test(node.raws.between)) {
            replace({ start: betweenStart, end: range.opening, text: ' ' });
          }
          // Empty blocks do not need to be expanded for reviewability.
          if (node.nodes.length > 0) {
            visit({ container: node, depth: depth + 1, opening: range.opening, closing: range.closing });
          }
        }
        cursor = range?.end ?? node.source.end.offset;
      } else if (node.type === 'decl') {
        const range = declarationRange({ node, css });
        if (!range) {
          cursor = node.source.end.offset;
        } else {
          // Custom-property token streams include significant whitespace,
          // including empty/whitespace-only values. Keep that entire stream.
          if (!node.prop.startsWith('--') && node.value.trim().length > 0
            && /^[\t\n\f\r ]*:[\t\n\f\r ]*$/u.test(node.raws.between)) {
            const after = node.raws.between.slice(node.raws.between.indexOf(':') + 1);
            replace({
              start: range.propEnd, end: range.propEnd + node.raws.between.length,
              text: `:${/[\r\n]/u.test(after) ? after : ' '}`,
            });
          }
          const semicolon = css[range.end] === ';';
          if (!semicolon) {
            replace({ start: range.end, end: range.end, text: ';' });
          }
          cursor = range.end + (semicolon ? 1 : 0);
        }
      } else {
        cursor = node.source.end.offset;
      }
      previous = node;
    }
    if (closing !== undefined) {
      gap({ start: cursor, end: closing, depth: depth - 1, mode: 'line' });
    } else if (embedded && container.nodes.length > 0) {
      gap({ start: cursor, end: css.length, depth: 0, mode: 'line' });
    }
  }

  visit({ container: root, depth: 0, opening: undefined, closing: undefined });
  return edits.sort((left, right) => left.start - right.start || left.end - right.end);
}

function hasPositionSensitiveComment({ root }) {
  let protectedComment = false;
  root.walkComments(node => {
    if (/\b(?:eslint|stylelint)-disable(?:-next-line|-line)?\b|\b(?:prettier-ignore|biome-ignore)\b/u.test(node.text)) {
      protectedComment = true;
    }
  });
  return protectedComment;
}

/** @type {import('eslint').Rule.RuleModule} */
export const rule = {
  meta: {
    type: 'layout',
    docs: { description: 'Lay out CSS blocks and declarations for review without rewriting values or selector/property order.' },
    // Final declaration semicolons are the only non-whitespace edits.
    fixable: 'code',
    schema: [],
    messages: {
      layout: 'Use multiline CSS blocks, two-space indentation, and separate declarations.',
      syntax: 'Cannot format invalid CSS: {{reason}}.',
      directive: 'Format this CSS manually: a suppression or ignore comment prevents safe automatic layout changes.',
    },
  },
  create(context) {
    const sourceCode = context.sourceCode;

    function check({ css, offset, stylesheet, embedded }) {
      if (!stylesheet) {
        try {
          stylesheet = parseStylesheet({ css });
        } catch (error) {
          if (error.name !== 'CssSyntaxError') {
            throw error;
          }
          const index = offset + syntaxErrorOffset({ css, error });
          context.report({ loc: sourceCode.getLocFromIndex(index), messageId: 'syntax', data: { reason: error.reason } });
          return;
        }
      }
      const { root, prefix, unsafe } = stylesheet;
      if (unsafe) {
        return;
      }
      const body = css.slice(prefix);
      const newline = /\r\n|[\n\r]/u.exec(css)?.[0] ?? /\r\n|[\n\r]/u.exec(sourceCode.text)?.[0] ?? '\n';
      const edits = layoutEdits({ root, css: body, newline, embedded });
      if (edits.length === 0) {
        return;
      }
      const protectedComment = hasPositionSensitiveComment({ root });
      context.report({
        loc: sourceCode.getLocFromIndex(offset + prefix + edits[0].start),
        messageId: protectedComment ? 'directive' : 'layout',
        fix: protectedComment ? undefined : fixer => edits.map(edit => fixer.replaceTextRange(
          [offset + prefix + edit.start, offset + prefix + edit.end], edit.text,
        )),
      });
    }

    return {
      'Program:exit'() {
        const stylesheet = sourceCode.parserServices.cssLayoutStylesheet;
        if (stylesheet) {
          check({ css: sourceCode.text, offset: 0, stylesheet, embedded: false });
          return;
        }
        const fragment = sourceCode.parserServices.getDocumentFragment?.();
        for (const node of fragment?.children ?? []) {
          if (node.type !== 'VElement' || node.name !== 'style' || !node.endTag) {
            continue;
          }
          const attributes = node.startTag.attributes;
          if (attributes.some(attribute => !attribute.directive && attribute.key.name === 'src')) {
            continue;
          }
          const language = attributes.find(attribute => !attribute.directive && attribute.key.name === 'lang')?.value?.value;
          if (language !== undefined && language !== 'css') {
            continue;
          }
          const offset = node.startTag.range[1];
          const end = node.endTag.range[0];
          // Keep <style> tags on their own lines when the body started inline.
          // The edits below only touch the body, never template/script text.
          const css = sourceCode.text.slice(offset, end);
          check({ css, offset, stylesheet: undefined, embedded: true });
        }
      },
    };
  },
};

const plugin = { rules: { 'css-layout': rule } };

export default [
  {
    name: 'naidan/css-layout-stylesheets',
    files: ['src/**/*.css', 'docs/**/*.css'],
    languageOptions: { parser: cssParser },
    plugins: { 'local-rules-css-layout': plugin },
    rules: { [ruleId]: 'error' },
  },
  {
    name: 'naidan/css-layout-vue',
    files: ['src/**/*.vue', 'docs/**/*.vue'],
    plugins: { 'local-rules-css-layout': plugin },
    rules: { [ruleId]: 'error' },
  },
];
