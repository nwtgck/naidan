import { getProtectedLines } from './layout-directive-safety.js';

const ruleId = 'local-rules-function-spacing/function-spacing';
const lineBreakPattern = /\r\n|[\n\r\u2028\u2029]/gu;

function unwrapExport({ node }) {
  return node.type === 'ExportNamedDeclaration' || node.type === 'ExportDefaultDeclaration'
    ? node.declaration
    : node;
}

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

function isFunctionValue({ node }) {
  node = unwrapExpression({ node });
  return node?.type === 'ArrowFunctionExpression' || node?.type === 'FunctionExpression';
}

function isTopLevelImplementation({ statement }) {
  const node = unwrapExport({ node: statement });
  if (!node || node.declare) return false;
  if (node.type === 'FunctionDeclaration') return node.body?.type === 'BlockStatement';
  if (node.type === 'VariableDeclaration') {
    // Do not split a mixed/multiple declaration or treat a destructuring
    // initializer, factory call, callback, or function reference as a definition.
    const declaration = node.declarations[0];
    return node.declarations.length === 1
      && declaration.id.type === 'Identifier'
      && isFunctionValue({ node: declaration.init });
  }
  return statement.type === 'ExportDefaultDeclaration' && isFunctionValue({ node });
}

function isFunctionOverload({ signature, implementation }) {
  const left = unwrapExport({ node: signature });
  const right = unwrapExport({ node: implementation });
  if (left?.type !== 'TSDeclareFunction' || left.declare
    || right?.type !== 'FunctionDeclaration'
    || (right.id ? left.id?.name !== right.id.name
      : implementation.type !== 'ExportDefaultDeclaration' || left.id !== null)) return false;
  const signatureExported = signature !== left;
  const implementationExported = implementation !== right;
  return signatureExported === implementationExported
    && (!signatureExported || signature.type === implementation.type);
}

// Only compare simple spellings, never evaluate computed keys. Calls and
// arbitrary expressions might name different properties on successive reads.
function stableKey({ node, computed }) {
  if (node.type === 'PrivateIdentifier') return `private:${node.name}`;
  if (!computed && node.type === 'Identifier') return `public:${node.name}`;
  if (node.type === 'Literal' && ['string', 'number'].includes(typeof node.value)) {
    return `public:${String(node.value)}`;
  }
  if (computed && node.type === 'Identifier') return `computed:${node.name}`;
  if (computed && node.type === 'MemberExpression' && !node.computed && !node.optional
    && node.property.type === 'Identifier') {
    const owner = stableKey({ node: node.object, computed: true });
    return owner === undefined ? undefined : `${owner}.${node.property.name}`;
  }
  return undefined;
}

function isMethodImplementation({ node }) {
  return node.type === 'MethodDefinition' && node.value?.body?.type === 'BlockStatement';
}

function sameMember({ left, right }) {
  const key = stableKey({ node: left.key, computed: left.computed });
  return key !== undefined
    && key === stableKey({ node: right.key, computed: right.computed })
    && left.static === right.static;
}

function isMethodOverload({ signature, implementation }) {
  return signature.type === 'MethodDefinition'
    && signature.value?.type === 'TSEmptyBodyFunctionExpression'
    && ['method', 'constructor'].includes(signature.kind)
    && signature.kind === implementation.kind
    && sameMember({ left: signature, right: implementation });
}

function isAccessorPair({ left, right }) {
  return isMethodImplementation({ node: left }) && isMethodImplementation({ node: right })
    && ((left.kind === 'get' && right.kind === 'set') || (left.kind === 'set' && right.kind === 'get'))
    && sameMember({ left, right });
}

/** @type {import('eslint').Rule.RuleModule} */
export const rule = {
  meta: {
    type: 'layout',
    docs: {
      description: 'Separate top-level function definitions and implemented class methods without padding objects, types, or local functions.',
    },
    fixable: 'whitespace',
    schema: [],
    messages: {
      spacing: 'Add a blank line at this function or class method boundary.',
      inline: 'Add separation manually: automatic spacing would split an existing code line.',
      commentAttachment: 'Add separation manually: moving a trailing documentation comment may change its attachment.',
      directive: 'Add separation manually: a line-sensitive directive prevents safe automatic spacing.',
    },
  },
  create(context) {
    const sourceCode = context.sourceCode;
    const text = sourceCode.text;
    const protectedLines = getProtectedLines({ sourceCode });
    // vue-eslint-parser merges both script blocks into one Program. They are
    // not adjacent source statements, even when the merged AST says they are.
    const scriptRanges = sourceCode.parserServices.getDocumentFragment?.()?.children
      .filter(node => node.type === 'VElement' && node.name === 'script' && node.endTag)
      .map(node => [node.startTag.range[1], node.endTag.range[0]]);

    function sameScript({ left, right }) {
      if (!scriptRanges) return true;
      return scriptRanges.some(([start, end]) => left.range[0] >= start && right.range[1] <= end);
    }

    function crossesDirective({ line }) {
      // Inserting after this physical line is safe before an entire directive
      // and its target, but not inside a next-line/counted suppression span.
      let low = 0;
      let high = protectedLines.length;
      while (low < high) {
        const middle = Math.floor((low + high) / 2);
        if (protectedLines[middle].end <= line) low = middle + 1;
        else high = middle;
      }
      return low < protectedLines.length && protectedLines[low].start <= line;
    }

    function checkBoundary({ previous, next, classBody }) {
      if (!previous.target && !next.target) return;
      if (previous.last.range[1] > next.first.range[0]) return;
      if (!sameScript({ left: previous.last, right: next.first })) return;
      let left = previous.last;
      const right = next.first;
      const middle = sourceCode.getTokensBetween(left, right, { includeComments: true });
      // Class bodies omit empty semicolon members from the AST. Keep them with
      // the preceding member; never introduce an empty, separately padded unit.
      const isSeparator = token => token.type === 'Punctuator' && token.value === ';';
      if (middle.some(token => token.type !== 'Line' && token.type !== 'Block'
        && !(classBody && isSeparator(token)))) return;
      const offset = classBody ? middle.findLastIndex(isSeparator) + 1 : 0;
      if (offset > 0) left = middle[offset - 1];
      const comments = middle.slice(offset);
      const parts = [left, ...comments, right];
      const gaps = parts.slice(1).map((part, index) => ({
        left: parts[index],
        right: part,
        text: text.slice(parts[index].range[1], part.range[0]),
      }));
      // This also excludes non-script source gaps and parser-generated nodes.
      if (gaps.some(gap => /\S/u.test(gap.text))) return;
      // Blank lines inside comments are not separation. Existing external
      // blank lines anywhere in the boundary are preserved, never normalized.
      if (gaps.some(gap => (gap.text.match(lineBreakPattern)?.length ?? 0) >= 2)) return;

      let trailing = 0;
      while (trailing < comments.length && comments[trailing].loc.start.line === parts[trailing].loc.end.line) {
        trailing += 1;
      }
      // Keep same-line comments with the preceding definition, and leave the
      // complete following comment/decorator group attached to its definition.
      const gap = gaps[trailing];
      const match = /\r\n|[\n\r\u2028\u2029]/u.exec(gap.text);
      const hasTrailingDocumentation = [...middle.slice(0, offset), ...comments.slice(0, trailing)]
        .some(comment => comment.type === 'Block' && comment.value.startsWith('*'));
      const breakIndex = match ? gap.left.range[1] + match.index : undefined;
      const reason = hasTrailingDocumentation ? 'commentAttachment'
        : breakIndex === undefined ? 'inline'
          : crossesDirective({ line: sourceCode.getLocFromIndex(breakIndex).line }) ? 'directive'
            : undefined;
      context.report({
        node: right,
        loc: sourceCode.getFirstToken(right).loc,
        messageId: reason ?? 'spacing',
        fix: reason ? undefined : fixer => fixer.insertTextAfterRange(
          [breakIndex, breakIndex + match[0].length], match[0],
        ),
      });
    }

    function checkUnits({ units, classBody }) {
      for (let index = 1; index < units.length; index += 1) {
        checkBoundary({ previous: units[index - 1], next: units[index], classBody });
      }
    }

    return {
      'Program:exit'(node) {
        const units = [];
        for (const statement of node.body) {
          if (statement.type === 'EmptyStatement') {
            const previous = units.at(-1);
            if (previous && sameScript({ left: previous.last, right: statement })) previous.last = statement;
            continue;
          }
          const unit = { first: statement, last: statement, target: isTopLevelImplementation({ statement }) };
          if (unit.target) {
            while (units.length > 0) {
              const previous = units.at(-1);
              if (previous.first !== previous.last
                || !sameScript({ left: previous.first, right: statement })
                || !isFunctionOverload({ signature: previous.first, implementation: statement })) break;
              unit.first = units.pop().first;
            }
          }
          units.push(unit);
        }
        checkUnits({ units, classBody: false });
      },
      'ClassBody:exit'(node) {
        const units = [];
        for (const member of node.body) {
          const unit = { first: member, last: member, target: isMethodImplementation({ node: member }) };
          if (unit.target) {
            while (units.length > 0) {
              const previous = units.at(-1);
              if (previous.first !== previous.last
                || !isMethodOverload({ signature: previous.first, implementation: member })) break;
              unit.first = units.pop().first;
            }
            const previous = units.at(-1);
            if (unit.first === member && previous && previous.first === previous.last
              && isAccessorPair({ left: previous.last, right: member })) {
              unit.first = units.pop().first;
            }
          }
          units.push(unit);
        }
        checkUnits({ units, classBody: true });
      },
    };
  },
};

export default {
  files: ['**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts,vue}'],
  plugins: {
    'local-rules-function-spacing': {
      rules: { 'function-spacing': rule },
    },
  },
  rules: { [ruleId]: 'error' },
};
