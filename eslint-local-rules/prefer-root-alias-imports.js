import path from 'node:path';
import process from 'node:process';

// Naidan-local import policy: keep same-folder ./ imports local, but
// rewrite parent-folder imports that stay inside src to the @/... root alias.

function normalizePath(filePath) {
  return filePath.replace(/\\/g, '/');
}

function isPathInside({ parentDir, childPath }) {
  const relativePath = path.relative(parentDir, childPath);
  return relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath));
}

function splitImportSuffix(importPath) {
  const suffixIndex = importPath.search(/[?#]/);
  if (suffixIndex === -1) {
    return { pathPart: importPath, suffix: '' };
  }

  return {
    pathPart: importPath.slice(0, suffixIndex),
    suffix: importPath.slice(suffixIndex),
  };
}

function getStringLiteralValue(node) {
  if (!node || typeof node.value !== 'string') {
    return undefined;
  }

  return node.value;
}

function buildReplacement({ context, importPath, filename }) {
  if (!importPath.startsWith('../')) {
    return undefined;
  }

  const [rawOptions = {}] = context.options;
  const rootDirOption = rawOptions.rootDir ?? 'src';
  const aliasPrefix = rawOptions.aliasPrefix ?? '@';

  const cwd = context.cwd ?? process.cwd();
  const rootDir = path.resolve(cwd, rootDirOption);
  const absoluteFilename = path.resolve(filename);
  if (!isPathInside({ parentDir: rootDir, childPath: absoluteFilename })) {
    return undefined;
  }

  const currentDir = path.dirname(absoluteFilename);
  const { pathPart, suffix } = splitImportSuffix(importPath);
  const resolvedImportPath = path.resolve(currentDir, pathPart);

  if (!isPathInside({ parentDir: rootDir, childPath: resolvedImportPath })) {
    return undefined;
  }

  const rootRelativePath = normalizePath(path.relative(rootDir, resolvedImportPath));
  const aliasPath = rootRelativePath === ''
    ? aliasPrefix
    : `${aliasPrefix}/${rootRelativePath}`;

  return `${aliasPath}${suffix}`;
}

function quoteReplacement({ sourceCode, sourceNode, replacement }) {
  const sourceText = sourceCode.getText(sourceNode);
  const quote = sourceText.startsWith('"') ? '"' : sourceText.startsWith('`') ? '`' : '\'';
  return `${quote}${replacement}${quote}`;
}

function createImportPathReporter(context) {
  const sourceCode = context.sourceCode ?? context.getSourceCode();
  const filename = context.filename ?? context.getFilename?.() ?? '';

  function checkSourceNode(sourceNode) {
    const importPath = getStringLiteralValue(sourceNode);
    if (importPath === undefined) {
      return;
    }

    const replacement = buildReplacement({ context, importPath, filename });
    if (replacement === undefined) {
      return;
    }

    context.report({
      node: sourceNode,
      messageId: 'preferRootAliasImport',
      data: {
        importPath,
        replacement,
      },
      fix(fixer) {
        return fixer.replaceText(
          sourceNode,
          quoteReplacement({ sourceCode, sourceNode, replacement }),
        );
      },
    });
  }

  return checkSourceNode;
}

export const rule = {
  meta: {
    type: 'suggestion',
    docs: {
      description: 'Prefer the root alias for imports that leave the current folder.',
    },
    fixable: 'code',
    messages: {
      preferRootAliasImport: 'Use root alias import "{{replacement}}" instead of "{{importPath}}".',
    },
    schema: [
      {
        type: 'object',
        properties: {
          rootDir: { type: 'string' },
          aliasPrefix: { type: 'string' },
        },
        additionalProperties: false,
      },
    ],
  },
  create(context) {
    const checkSourceNode = createImportPathReporter(context);

    return {
      ImportDeclaration(node) {
        checkSourceNode(node.source);
      },
      ExportNamedDeclaration(node) {
        checkSourceNode(node.source);
      },
      ExportAllDeclaration(node) {
        checkSourceNode(node.source);
      },
      ImportExpression(node) {
        checkSourceNode(node.source);
      },
      TSImportType(node) {
        checkSourceNode(node.source ?? node.argument);
      },
    };
  },
};

export default {
  files: ['src/**/*.ts', 'src/**/*.vue'],
  plugins: {
    'local-rules-imports': {
      rules: {
        'prefer-root-alias-imports': rule,
      },
    },
  },
  rules: {
    'local-rules-imports/prefer-root-alias-imports': [
      'error',
      { rootDir: 'src', aliasPrefix: '@' },
    ],
  },
};
