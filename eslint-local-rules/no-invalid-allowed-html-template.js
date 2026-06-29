const ALLOWED_TAGS = new Set(['div', 'span', 'br', 'code', 'pre', 'kbd', 'strong', 'em', 'small']);
const ALLOWED_ATTRS = new Set(['class', 'role', 'data-testid']);
const ALLOWED_HTML_MODULES = new Set(['@/logic/security/allowedHtml']);

function isAllowedAttribute({ name }) {
  return ALLOWED_ATTRS.has(name) || name.startsWith('aria-');
}

function validateHtmlLiteral({ html }) {
  const errors = [];
  const tagPattern = /<\s*(\/)?\s*([a-zA-Z][a-zA-Z0-9:-]*)([^>]*)>/gu;
  let match;

  while ((match = tagPattern.exec(html)) !== null) {
    const [, closingSlash, tagNameRaw, attrsRaw = ''] = match;
    const tagName = tagNameRaw.toLowerCase();
    if (!ALLOWED_TAGS.has(tagName)) {
      errors.push(`Tag <${tagName}> is not allowed in allowedHtml templates.`);
      continue;
    }

    if (closingSlash) {
      continue;
    }

    const attrPattern = /([:@a-zA-Z_][:@a-zA-Z0-9_.-]*)(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?/gu;
    let attrMatch;
    while ((attrMatch = attrPattern.exec(attrsRaw)) !== null) {
      const attrName = attrMatch[1].toLowerCase();
      if (!isAllowedAttribute({ name: attrName })) {
        errors.push(`Attribute ${attrName} is not allowed in allowedHtml templates.`);
      }
    }
  }

  return errors;
}

function isAllowedHtmlModule({ source }) {
  return typeof source === 'string' && (ALLOWED_HTML_MODULES.has(source) || /(?:^|\/)allowedHtml$/u.test(source));
}

function getImportedName(specifier) {
  if (specifier.type !== 'ImportSpecifier') {
    return undefined;
  }

  if (specifier.imported.type === 'Identifier') {
    return specifier.imported.name;
  }

  return specifier.imported.value;
}

function isIdentifierInSet(node, names) {
  return node?.type === 'Identifier' && names.has(node.name);
}

export const rule = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Validate allowedHtml tagged template literals.',
    },
    messages: {
      aliasImport: 'Import allowedHtml without an alias so static AllowedHtml literals are easy to audit.',
      directCall: 'allowedHtml must be used as a tagged template, not as a direct function call.',
      interpolation: 'allowedHtml templates must not use interpolations.',
      invalidLiteral: '{{message}}',
      namespaceImport: 'Do not namespace-import allowedHtml helpers. Import allowedHtml directly so its templates can be audited.',
    },
    schema: [],
  },
  create(context) {
    const allowedHtmlNames = new Set(['allowedHtml']);

    return {
      ImportDeclaration(node) {
        if (!isAllowedHtmlModule({ source: node.source.value })) {
          return;
        }

        for (const specifier of node.specifiers) {
          if (specifier.type === 'ImportNamespaceSpecifier') {
            context.report({ node: specifier, messageId: 'namespaceImport' });
            continue;
          }

          if (getImportedName(specifier) !== 'allowedHtml') {
            continue;
          }

          if (specifier.local.name !== 'allowedHtml') {
            context.report({ node: specifier, messageId: 'aliasImport' });
            continue;
          }

          allowedHtmlNames.add(specifier.local.name);
        }
      },
      CallExpression(node) {
        if (isIdentifierInSet(node.callee, allowedHtmlNames)) {
          context.report({ node, messageId: 'directCall' });
        }
      },
      TaggedTemplateExpression(node) {
        if (!isIdentifierInSet(node.tag, allowedHtmlNames)) {
          return;
        }

        if (node.quasi.expressions.length !== 0) {
          context.report({ node, messageId: 'interpolation' });
          return;
        }

        const html = node.quasi.quasis.map(quasi => quasi.value.cooked ?? quasi.value.raw).join('');
        for (const message of validateHtmlLiteral({ html })) {
          context.report({ node, messageId: 'invalidLiteral', data: { message } });
        }
      },
    };
  },
};

export default {
  files: ['src/**/*.ts', 'src/**/*.vue'],
  ignores: ['src/**/*.test.ts', 'src/**/*.spec.ts'],
  plugins: {
    'local-rules-allowed-html-template': {
      rules: {
        'no-invalid-allowed-html-template': rule,
      },
    },
  },
  rules: {
    'local-rules-allowed-html-template/no-invalid-allowed-html-template': 'error',
  },
};
