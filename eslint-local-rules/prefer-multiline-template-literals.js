function isQuotedStringLiteral(node) {
  return (
    node.type === 'Literal' &&
    typeof node.value === 'string' &&
    typeof node.raw === 'string' &&
    (node.raw.startsWith("'") || node.raw.startsWith('"'))
  );
}

function hasMeaningfulEmbeddedNewline(value) {
  return /(?:\r?\n).+/s.test(value);
}

function isEscapedMultilineLiteral(node) {
  return /\\r\\n|\\n|\\r/.test(node.raw);
}

function hasOnlyNewlineEscapes(raw) {
  const body = raw.slice(1, -1);

  for (let index = 0; index < body.length; index += 1) {
    if (body[index] !== '\\') {
      continue;
    }

    const nextChar = body[index + 1];
    if (nextChar === 'r' || nextChar === 'n') {
      index += 1;
      continue;
    }

    return false;
  }

  return true;
}

function hasMultipleNonEmptyLines(value) {
  return value
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .length >= 2;
}

function escapeTemplateLine(line) {
  return line
    .replace(/\\/g, '\\\\')
    .replace(/`/g, '\\`')
    .replace(/\$\{/g, '\\${')
}

function toMultilineTemplateLiteral(value) {
  const body = value
    .replace(/\r/g, '\\r')
    .split('\n')
    .map(escapeTemplateLine)
    .join('\n');

  return `\`\\
${body}\``;
}

export const rule = {
  meta: {
    type: 'suggestion',
    docs: {
      description: 'Prefer template literals with real newlines for multiline string literals.',
    },
    fixable: 'code',
    schema: [],
    messages: {
      preferTemplateLiteral: 'Use a template literal that starts with `\\\\ and real newlines for multiline string literals.',
    },
  },
  create(context) {
    return {
      Literal(node) {
        if (!isQuotedStringLiteral(node)) {
          return;
        }

        if (
          !hasMeaningfulEmbeddedNewline(node.value) ||
          !isEscapedMultilineLiteral(node) ||
          !hasOnlyNewlineEscapes(node.raw) ||
          !hasMultipleNonEmptyLines(node.value)
        ) {
          return;
        }

        context.report({
          node,
          messageId: 'preferTemplateLiteral',
          fix(fixer) {
            return fixer.replaceText(node, toMultilineTemplateLiteral(node.value));
          },
        });
      },
    };
  },
};

export default {
  files: ['**/*.ts', '**/*.vue'],
  plugins: {
    'local-rules-multiline-template-literals': {
      rules: {
        'prefer-multiline-template-literals': rule,
      },
    },
  },
  rules: {
    'local-rules-multiline-template-literals/prefer-multiline-template-literals': 'error',
  },
};
