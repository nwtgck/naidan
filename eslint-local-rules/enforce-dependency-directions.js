import path from 'node:path';
import process from 'node:process';

function normalizePath({ filePath }) {
  return filePath.replace(/\\/g, '/');
}

function isPathInside({ parentDir, childPath }) {
  const relativePath = path.relative(parentDir, childPath);
  return relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath));
}

function splitImportSuffix({ importPath }) {
  const suffixIndex = importPath.search(/[?#]/);
  return suffixIndex === -1 ? importPath : importPath.slice(0, suffixIndex);
}

function getStaticStringValue({ node }) {
  if (node && typeof node.value === 'string') {
    return node.value;
  }

  if (node?.type === 'TemplateLiteral'
    && node.expressions.length === 0
    && node.quasis.length === 1) {
    return node.quasis[0]?.value.cooked ?? node.quasis[0]?.value.raw;
  }

  return undefined;
}

function resolveSourcePath({ context, filename }) {
  const [rawOptions = {}] = context.options;
  const rootDirOption = rawOptions.rootDir ?? 'src';
  const cwd = context.cwd ?? process.cwd();
  const rootDir = path.resolve(cwd, rootDirOption);
  const sourcePath = path.resolve(filename);

  if (!isPathInside({ parentDir: rootDir, childPath: sourcePath })) {
    return undefined;
  }

  return { rootDir, sourcePath };
}

function resolveImportPath({ context, filename, importPath }) {
  const source = resolveSourcePath({ context, filename });
  if (source === undefined) {
    return undefined;
  }

  const [rawOptions = {}] = context.options;
  const aliasPrefixes = rawOptions.aliasPrefixes ?? ['@', '~'];
  const pathPart = splitImportSuffix({ importPath });
  const aliasPrefix = aliasPrefixes.find((candidate) => pathPart.startsWith(`${candidate}/`));

  let targetPath;
  if (aliasPrefix !== undefined) {
    targetPath = path.resolve(source.rootDir, pathPart.slice(aliasPrefix.length + 1));
  } else if (pathPart.startsWith('./') || pathPart.startsWith('../')) {
    targetPath = path.resolve(path.dirname(source.sourcePath), pathPart);
  } else {
    return undefined;
  }

  if (!isPathInside({ parentDir: source.rootDir, childPath: targetPath })) {
    return undefined;
  }

  return {
    rootDir: source.rootDir,
    sourcePath: source.sourcePath,
    targetPath,
  };
}

function classifyPath({ rootDir, filePath }) {
  const relativePath = normalizePath({ filePath: path.relative(rootDir, filePath) });
  const [firstSegment] = relativePath.split('/');

  if (relativePath === 'constants.ts') {
    return 'constants';
  }
  if (firstSegment === '01-models') {
    return '01-models';
  }
  if (relativePath === '00-storage/service' || relativePath.startsWith('00-storage/service/')) {
    return 'storage-service';
  }
  if (relativePath === '00-storage/mapper' || relativePath.startsWith('00-storage/mapper/')) {
    return 'storage-mapper';
  }
  if (relativePath === '00-storage/00-dto' || relativePath.startsWith('00-storage/00-dto/')) {
    return 'storage-dto';
  }
  if (['features', 'components', 'composables', 'logic', 'pages'].includes(firstSegment)) {
    return 'application';
  }
  if (!relativePath.includes('/') && /\.(?:ts|tsx|vue)$/.test(relativePath)) {
    return 'application';
  }
  if (firstSegment === 'utils') {
    return 'utils';
  }
  if (firstSegment === 'strings') {
    return 'strings';
  }
  return 'other';
}

function isForbiddenDependency({ sourceCategory, targetCategory }) {
  if (sourceCategory === 'application') {
    return targetCategory === 'storage-mapper' || targetCategory === 'storage-dto';
  }

  if (sourceCategory === '01-models') {
    return [
      'application',
      'storage-service',
      'storage-mapper',
      'storage-dto',
      'strings',
    ].includes(targetCategory);
  }

  if (sourceCategory === 'storage-service') {
    return targetCategory === 'application' || targetCategory === 'strings';
  }

  if (sourceCategory === 'storage-mapper') {
    return [
      'application',
      'storage-service',
      'strings',
    ].includes(targetCategory);
  }

  if (sourceCategory === 'storage-dto') {
    return [
      'application',
      'storage-service',
      'storage-mapper',
      'strings',
    ].includes(targetCategory);
  }

  if (sourceCategory === 'constants') {
    return [
      'application',
      '01-models',
      'storage-service',
      'storage-mapper',
      'storage-dto',
      'strings',
    ].includes(targetCategory);
  }

  if (sourceCategory === 'utils') {
    return [
      'application',
      '01-models',
      'storage-service',
      'storage-mapper',
      'storage-dto',
      'strings',
    ].includes(targetCategory);
  }

  return false;
}

function createImportPathReporter({ context }) {
  const filename = context.filename ?? context.getFilename?.() ?? '';

  function checkSourceNode({ sourceNode, reportNode }) {
    const importPath = getStaticStringValue({ node: sourceNode });
    if (importPath === undefined) {
      return;
    }

    const resolved = resolveImportPath({ context, filename, importPath });
    if (resolved === undefined) {
      return;
    }

    const sourceCategory = classifyPath({ rootDir: resolved.rootDir, filePath: resolved.sourcePath });
    const targetCategory = classifyPath({ rootDir: resolved.rootDir, filePath: resolved.targetPath });
    if (!isForbiddenDependency({ sourceCategory, targetCategory })) {
      return;
    }

    context.report({
      node: reportNode ?? sourceNode,
      messageId: 'forbiddenDependencyDirection',
      data: {
        importPath,
        sourceCategory,
        targetCategory,
      },
    });
  }

  return checkSourceNode;
}

const testModuleReferenceMethods = new Set([
  'mock',
  'doMock',
  'unmock',
  'doUnmock',
  'importActual',
  'importMock',
  'requireActual',
  'requireMock',
]);

function getCallSourceNode({ node }) {
  if (node.type !== 'CallExpression' || node.arguments.length === 0) {
    return undefined;
  }

  const callee = node.callee;
  const isRequire = callee.type === 'Identifier' && callee.name === 'require';
  const isRequireResolve = callee.type === 'MemberExpression'
    && !callee.computed
    && callee.object.type === 'Identifier'
    && callee.object.name === 'require'
    && callee.property.type === 'Identifier'
    && callee.property.name === 'resolve';
  const isTestModuleReference = callee.type === 'MemberExpression'
    && !callee.computed
    && callee.object.type === 'Identifier'
    && ['vi', 'jest'].includes(callee.object.name)
    && callee.property.type === 'Identifier'
    && testModuleReferenceMethods.has(callee.property.name);

  if (!isRequire && !isRequireResolve && !isTestModuleReference) {
    return undefined;
  }

  const [sourceNode] = node.arguments;
  return getStaticStringValue({ node: sourceNode }) === undefined ? undefined : sourceNode;
}

function isImportMetaMember({ node, propertyName }) {
  return node?.type === 'MemberExpression'
    && !node.computed
    && node.object?.type === 'MetaProperty'
    && node.object.meta?.name === 'import'
    && node.object.property?.name === 'meta'
    && node.property?.type === 'Identifier'
    && node.property.name === propertyName;
}

function getImportMetaGlobSourceNodes({ node }) {
  if (node.type !== 'CallExpression'
    || !isImportMetaMember({ node: node.callee, propertyName: 'glob' })
    || node.arguments.length === 0) {
    return [];
  }

  const [sourceArgument] = node.arguments;
  if (getStaticStringValue({ node: sourceArgument }) !== undefined) {
    return [sourceArgument];
  }
  if (sourceArgument?.type === 'ArrayExpression') {
    return sourceArgument.elements.filter(
      (element) => getStaticStringValue({ node: element }) !== undefined,
    );
  }
  return [];
}

function isImportMetaUrl({ node }) {
  return isImportMetaMember({ node, propertyName: 'url' });
}

function getUrlSourceNode({ node }) {
  if (node.type !== 'NewExpression'
    || node.callee.type !== 'Identifier'
    || node.callee.name !== 'URL'
    || node.arguments.length < 2
    || !isImportMetaUrl({ node: node.arguments[1] })) {
    return undefined;
  }

  const [sourceNode] = node.arguments;
  return getStaticStringValue({ node: sourceNode }) === undefined ? undefined : sourceNode;
}

export const rule = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Enforce Naidan source dependency directions.',
    },
    messages: {
      forbiddenDependencyDirection: '{{sourceCategory}} must not depend on {{targetCategory}} through "{{importPath}}".',
    },
    schema: [
      {
        type: 'object',
        properties: {
          rootDir: { type: 'string' },
          aliasPrefixes: {
            type: 'array',
            items: { type: 'string' },
            minItems: 1,
            uniqueItems: true,
          },
        },
        additionalProperties: false,
      },
    ],
  },
  create(context) {
    const checkSourceNode = createImportPathReporter({ context });

    return {
      ImportDeclaration(node) {
        checkSourceNode({ sourceNode: node.source, reportNode: node });
      },
      ExportNamedDeclaration(node) {
        if (node.source) {
          checkSourceNode({ sourceNode: node.source, reportNode: node });
        }
      },
      ExportAllDeclaration(node) {
        checkSourceNode({ sourceNode: node.source, reportNode: node });
      },
      ImportExpression(node) {
        checkSourceNode({ sourceNode: node.source, reportNode: node });
      },
      TSImportType(node) {
        checkSourceNode({ sourceNode: node.source ?? node.argument, reportNode: node });
      },
      CallExpression(node) {
        const sourceNode = getCallSourceNode({ node });
        if (sourceNode) {
          checkSourceNode({ sourceNode, reportNode: node });
        }
        for (const globSourceNode of getImportMetaGlobSourceNodes({ node })) {
          checkSourceNode({ sourceNode: globSourceNode, reportNode: node });
        }
      },
      NewExpression(node) {
        const sourceNode = getUrlSourceNode({ node });
        if (sourceNode) {
          checkSourceNode({ sourceNode, reportNode: node });
        }
      },
    };
  },
};

export default {
  files: ['src/**/*.{ts,tsx,vue}'],
  plugins: {
    'local-rules': {
      rules: {
        'enforce-dependency-directions': rule,
      },
    },
  },
  rules: {
    'local-rules/enforce-dependency-directions': [
      'error',
      { rootDir: 'src', aliasPrefixes: ['@', '~'] },
    ],
  },
};
