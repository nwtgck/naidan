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

function hasPathPrefix({ relativePath, prefix }) {
  return relativePath === prefix || relativePath.startsWith(`${prefix}/`);
}

function classifyPath({ rootDir, filePath }) {
  const relativePath = normalizePath({ filePath: path.relative(rootDir, filePath) });
  const [firstSegment] = relativePath.split('/');

  if (relativePath === 'constants.ts') return 'constants';
  if (firstSegment === '01-models') return '01-models';
  const hizofsRoot = '00-storage/service/hizofs';
  if (relativePath === `${hizofsRoot}/00-format` || relativePath === `${hizofsRoot}/00-format/index` || relativePath === `${hizofsRoot}/00-format/index.ts`) return 'hizofs-format-public';
  if (hasPathPrefix({ relativePath, prefix: `${hizofsRoot}/00-format` })) return 'hizofs-format-internal';
  if (hasPathPrefix({ relativePath, prefix: `${hizofsRoot}/compatibility` })) return 'hizofs-compatibility';
  if (relativePath === `${hizofsRoot}/01-crypto` || relativePath === `${hizofsRoot}/01-crypto/index` || relativePath === `${hizofsRoot}/01-crypto/index.ts`) return 'hizofs-crypto-public';
  if (hasPathPrefix({ relativePath, prefix: `${hizofsRoot}/01-crypto` })) return 'hizofs-crypto-internal';
  if (hasPathPrefix({ relativePath, prefix: `${hizofsRoot}/diagnostics` })) return 'hizofs-diagnostics';
  if (hasPathPrefix({ relativePath, prefix: `${hizofsRoot}/authenticated-store` })) return 'hizofs-authenticated-store';
  if (hasPathPrefix({ relativePath, prefix: `${hizofsRoot}/physical-store` })) return 'hizofs-physical-store';
  if (hasPathPrefix({ relativePath, prefix: `${hizofsRoot}/indexes` })) return 'hizofs-indexes';
  if (hasPathPrefix({ relativePath, prefix: `${hizofsRoot}/filesystem` })) return 'hizofs-filesystem';
  if (hasPathPrefix({ relativePath, prefix: `${hizofsRoot}/runtime` })) return 'hizofs-runtime';
  if (hasPathPrefix({ relativePath, prefix: `${hizofsRoot}/maintenance` })) return 'hizofs-maintenance';
  if (hasPathPrefix({ relativePath, prefix: `${hizofsRoot}/inspection` })) return 'hizofs-inspection';
  if (hasPathPrefix({ relativePath, prefix: `${hizofsRoot}/api` }) || relativePath === `${hizofsRoot}/index.ts`) return 'hizofs-api';
  if (
    relativePath === `${hizofsRoot}/worker/composition-root`
    || relativePath === `${hizofsRoot}/worker/composition-root.ts`
    || relativePath === `${hizofsRoot}/worker/tests/composition-root.test.ts`
    // This exact integration test composes real HizoFS authorities with the
    // ordinary Naidan provider. Keep the exception path explicit so sibling
    // worker tests cannot acquire the same deep dependency authority.
    || relativePath === `${hizofsRoot}/worker/tests/naidan-provider-restart.test.ts`
    // This exact integration test exercises encrypted, scope-bound Worker
    // grants through the real format, crypto, authenticated-store, and OPFS
    // composition boundary.
    || relativePath === `${hizofsRoot}/worker/tests/worker-mount-grant.test.ts`
  ) return 'hizofs-composition';
  if (relativePath === `${hizofsRoot}/worker-entry` || relativePath === `${hizofsRoot}/worker-entry.ts`) return 'hizofs-worker-entry';
  if (hasPathPrefix({ relativePath, prefix: `${hizofsRoot}/worker` })) return 'hizofs-worker';
  if (hasPathPrefix({ relativePath, prefix: `${hizofsRoot}/v1-format-tests` })) return 'hizofs-v1-format-tests';
  if (hasPathPrefix({ relativePath, prefix: hizofsRoot })) return 'hizofs-root';

  const controlRoot = '00-storage/service/naidan-persistence-control';
  if (hasPathPrefix({ relativePath, prefix: `${controlRoot}/00-format` })) return 'naidan-control-format';
  if (hasPathPrefix({ relativePath, prefix: `${controlRoot}/crypto` })) return 'naidan-control-crypto';
  if (hasPathPrefix({ relativePath, prefix: controlRoot })) return 'naidan-control-service';
  if ([
    '00-storage/service/naidan-opfs/production-persistence-runtime.ts',
    '00-storage/service/naidan-opfs/worker-mount-runtime.ts',
  ].includes(relativePath)) return 'naidan-opfs-composition';
  if (hasPathPrefix({ relativePath, prefix: '00-storage/service/naidan-opfs' })) return 'naidan-opfs';

  if (relativePath === '00-storage/service' || relativePath.startsWith('00-storage/service/')) return 'storage-service';
  if (relativePath === '00-storage/mapper' || relativePath.startsWith('00-storage/mapper/')) return 'storage-mapper';
  if (relativePath === '00-storage/00-dto' || relativePath.startsWith('00-storage/00-dto/')) return 'storage-dto';
  if (['features', 'components', 'composables', 'logic', 'pages'].includes(firstSegment)) return 'application';
  if (!relativePath.includes('/') && /\.(?:ts|tsx|vue)$/.test(relativePath)) return 'application';
  if (firstSegment === 'utils') return 'utils';
  if (firstSegment === 'strings') return 'strings';
  return 'other';
}

const HIZOFS_LOGICAL_CATEGORIES = new Set([
  'hizofs-indexes',
  'hizofs-filesystem',
  'hizofs-runtime',
  'hizofs-maintenance',
]);

function isHizoFSCategory({ category }) {
  return category.startsWith('hizofs-');
}

function isAllowedHizoFSDependency({ sourceCategory, targetCategory }) {
  if (!isHizoFSCategory({ category: targetCategory })) return true;

  if (sourceCategory === 'hizofs-format-internal') {
    return ['hizofs-format-internal', 'hizofs-format-public'].includes(targetCategory);
  }
  if (sourceCategory === 'hizofs-format-public') {
    return ['hizofs-format-internal', 'hizofs-format-public'].includes(targetCategory);
  }
  if (sourceCategory === 'hizofs-compatibility') {
    return ['hizofs-compatibility', 'hizofs-format-public'].includes(targetCategory);
  }
  if (sourceCategory === 'hizofs-crypto-internal') {
    return ['hizofs-crypto-internal', 'hizofs-crypto-public', 'hizofs-format-public'].includes(targetCategory);
  }
  if (sourceCategory === 'hizofs-crypto-public') {
    return ['hizofs-crypto-internal', 'hizofs-crypto-public', 'hizofs-format-public'].includes(targetCategory);
  }
  if (sourceCategory === 'hizofs-physical-store') return targetCategory === 'hizofs-physical-store';
  if (sourceCategory === 'hizofs-diagnostics') {
    return ['hizofs-diagnostics', 'hizofs-format-public'].includes(targetCategory);
  }
  if (sourceCategory === 'hizofs-authenticated-store') {
    return ['hizofs-authenticated-store', 'hizofs-diagnostics', 'hizofs-format-public', 'hizofs-crypto-public', 'hizofs-physical-store'].includes(targetCategory);
  }
  if (HIZOFS_LOGICAL_CATEGORIES.has(sourceCategory)) {
    return HIZOFS_LOGICAL_CATEGORIES.has(targetCategory)
      || ['hizofs-authenticated-store', 'hizofs-diagnostics', 'hizofs-format-public'].includes(targetCategory);
  }
  if (sourceCategory === 'hizofs-inspection') {
    return ['hizofs-inspection', 'hizofs-api', 'hizofs-authenticated-store', 'hizofs-format-public', 'hizofs-crypto-public'].includes(targetCategory);
  }
  if (sourceCategory === 'hizofs-api') {
    return targetCategory === 'hizofs-api'
      || targetCategory === 'hizofs-inspection'
      || targetCategory === 'hizofs-format-public'
      || HIZOFS_LOGICAL_CATEGORIES.has(targetCategory);
  }
  if (sourceCategory === 'hizofs-composition') {
    return targetCategory === 'hizofs-composition'
      || targetCategory === 'hizofs-worker'
      || targetCategory === 'hizofs-api'
      || targetCategory === 'hizofs-authenticated-store'
      || targetCategory === 'hizofs-diagnostics'
      || targetCategory === 'hizofs-format-public'
      || targetCategory === 'hizofs-crypto-public'
      || targetCategory === 'hizofs-physical-store'
      || HIZOFS_LOGICAL_CATEGORIES.has(targetCategory);
  }
  if (sourceCategory === 'hizofs-worker-entry') return ['hizofs-worker-entry', 'hizofs-composition'].includes(targetCategory);
  if (sourceCategory === 'hizofs-worker') return ['hizofs-worker-entry', 'hizofs-worker', 'hizofs-composition', 'hizofs-api', 'hizofs-diagnostics', 'hizofs-runtime'].includes(targetCategory);
  if (sourceCategory === 'hizofs-v1-format-tests') {
    return targetCategory === 'hizofs-v1-format-tests'
      || targetCategory === 'hizofs-composition'
      || targetCategory === 'hizofs-worker'
      || targetCategory === 'hizofs-api'
      || targetCategory === 'hizofs-authenticated-store'
      || targetCategory === 'hizofs-diagnostics'
      || targetCategory === 'hizofs-format-public'
      || targetCategory === 'hizofs-crypto-public'
      || targetCategory === 'hizofs-physical-store'
      || targetCategory === 'hizofs-runtime'
      || HIZOFS_LOGICAL_CATEGORIES.has(targetCategory);
  }
  if (sourceCategory === 'hizofs-root') return ['hizofs-api', 'hizofs-worker-entry', 'hizofs-worker', 'hizofs-composition', 'hizofs-compatibility'].includes(targetCategory);

  if (sourceCategory === 'naidan-control-format') return targetCategory === 'hizofs-compatibility';
  if (sourceCategory === 'naidan-control-crypto') return ['hizofs-api', 'hizofs-compatibility'].includes(targetCategory);
  if (sourceCategory === 'naidan-control-service') return ['hizofs-api', 'hizofs-compatibility'].includes(targetCategory);
  if (sourceCategory === 'naidan-opfs-composition') return ['hizofs-api', 'hizofs-inspection', 'hizofs-worker-entry'].includes(targetCategory);
  if (sourceCategory === 'naidan-opfs') return ['hizofs-api', 'hizofs-inspection'].includes(targetCategory);
  if (sourceCategory === 'application') return ['hizofs-api', 'hizofs-inspection'].includes(targetCategory);

  return false;
}

function getWeshCommandOwner({ rootDir, filePath }) {
  const relativePath = normalizePath({ filePath: path.relative(rootDir, filePath) });
  const commandsPrefix = 'features/wesh/commands/';
  if (!relativePath.startsWith(commandsPrefix)) {
    return undefined;
  }

  const commandRelativePath = relativePath.slice(commandsPrefix.length);
  const separatorIndex = commandRelativePath.indexOf('/');
  if (separatorIndex < 0) {
    if (commandRelativePath === 'index') {
      return undefined;
    }
    return path.extname(commandRelativePath) === '' ? commandRelativePath : undefined;
  }

  return commandRelativePath.slice(0, separatorIndex);
}

function isWeshCommandRootRegistry({ rootDir, filePath }) {
  const relativePath = normalizePath({ filePath: path.relative(rootDir, filePath) });
  return relativePath === 'features/wesh/commands'
    || relativePath === 'features/wesh/commands/index'
    || relativePath === 'features/wesh/commands/index.ts';
}

function isTestSourceFile({ filePath }) {
  return /\.(?:test|spec)\.(?:[cm]?[jt]sx?)$/.test(filePath);
}

function getWeshGitLayer({ rootDir, filePath }) {
  const relativePath = normalizePath({ filePath: path.relative(rootDir, filePath) });
  const gitPrefix = 'features/wesh/commands/git/';
  if (relativePath === 'features/wesh/commands/git/index' || relativePath === 'features/wesh/commands/git/index.ts') {
    return 'entry';
  }
  if (!relativePath.startsWith(gitPrefix)) {
    return undefined;
  }
  const gitRelativePath = relativePath.slice(gitPrefix.length);
  if (gitRelativePath === 'subcommands' || gitRelativePath.startsWith('subcommands/')) {
    return 'subcommand';
  }
  return 'domain';
}

function getWeshGitSubcommandOwner({ rootDir, filePath }) {
  const relativePath = normalizePath({ filePath: path.relative(rootDir, filePath) });
  const prefix = 'features/wesh/commands/git/subcommands/';
  if (!relativePath.startsWith(prefix)) {
    return undefined;
  }
  const subcommandRelativePath = relativePath.slice(prefix.length);
  const [firstSegment] = subcommandRelativePath.split('/');
  if (firstSegment === undefined || firstSegment.length === 0) {
    return undefined;
  }
  return firstSegment.replace(/\.[^.]+$/u, '');
}

function isForbiddenWeshGitLayerDependency({ sourceLayer, targetLayer, sourceSubcommandOwner, targetSubcommandOwner }) {
  if (sourceLayer === undefined || targetLayer === undefined || sourceLayer === 'entry') {
    return false;
  }
  if (targetLayer !== 'subcommand') {
    return false;
  }
  if (sourceLayer !== 'subcommand') {
    return true;
  }
  return sourceSubcommandOwner === undefined
    || targetSubcommandOwner === undefined
    || sourceSubcommandOwner !== targetSubcommandOwner;
}

function isForbiddenWeshCommandDependency({ sourceOwner, targetOwner }) {
  if (sourceOwner === undefined || targetOwner === undefined) {
    return false;
  }
  if (sourceOwner === targetOwner || targetOwner === '_shared') {
    return false;
  }
  return true;
}

function isForbiddenDependency({ sourceCategory, targetCategory }) {
  if (isHizoFSCategory({ category: sourceCategory }) || isHizoFSCategory({ category: targetCategory })) {
    return !isAllowedHizoFSDependency({ sourceCategory, targetCategory });
  }

  if (sourceCategory === 'naidan-control-format' && targetCategory !== 'naidan-control-format') {
    return targetCategory !== 'hizofs-compatibility' && targetCategory !== 'constants' && targetCategory !== 'utils';
  }
  if (sourceCategory === 'naidan-control-crypto') {
    return ['application', 'strings', 'storage-dto', 'storage-mapper'].includes(targetCategory);
  }
  if (['naidan-control-service', 'naidan-opfs-composition', 'naidan-opfs'].includes(sourceCategory)) {
    return targetCategory === 'application' || targetCategory === 'strings';
  }

  if (sourceCategory === 'application') {
    return ['storage-mapper', 'storage-dto', 'hizofs-format-internal', 'hizofs-format-public', 'naidan-control-format'].includes(targetCategory);
  }
  if (sourceCategory === '01-models') {
    return ['application', 'storage-service', 'storage-mapper', 'storage-dto', 'strings'].includes(targetCategory);
  }
  if (sourceCategory === 'storage-service') return targetCategory === 'application' || targetCategory === 'strings';
  if (sourceCategory === 'storage-mapper') return ['application', 'storage-service', 'strings'].includes(targetCategory);
  if (sourceCategory === 'storage-dto') return ['application', 'storage-service', 'storage-mapper', 'strings'].includes(targetCategory);
  if (sourceCategory === 'constants' || sourceCategory === 'utils') {
    return ['application', '01-models', 'storage-service', 'storage-mapper', 'storage-dto', 'strings'].includes(targetCategory);
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

    const sourceCommandOwner = getWeshCommandOwner({
      rootDir: resolved.rootDir,
      filePath: resolved.sourcePath,
    });
    const targetCommandOwner = getWeshCommandOwner({
      rootDir: resolved.rootDir,
      filePath: resolved.targetPath,
    });
    if (
      sourceCommandOwner !== undefined
      && isWeshCommandRootRegistry({
        rootDir: resolved.rootDir,
        filePath: resolved.targetPath,
      })
      && !isTestSourceFile({ filePath: resolved.sourcePath })
    ) {
      context.report({
        node: reportNode ?? sourceNode,
        messageId: 'forbiddenWeshCommandRegistryDependency',
        data: {
          importPath,
          sourceCommand: sourceCommandOwner,
        },
      });
      return;
    }
    if (isForbiddenWeshCommandDependency({
      sourceOwner: sourceCommandOwner,
      targetOwner: targetCommandOwner,
    })) {
      context.report({
        node: reportNode ?? sourceNode,
        messageId: 'forbiddenWeshCommandDependency',
        data: {
          importPath,
          sourceCommand: sourceCommandOwner,
          targetCommand: targetCommandOwner,
        },
      });
      return;
    }

    const sourceGitLayer = getWeshGitLayer({ rootDir: resolved.rootDir, filePath: resolved.sourcePath });
    const targetGitLayer = getWeshGitLayer({ rootDir: resolved.rootDir, filePath: resolved.targetPath });
    const sourceGitSubcommandOwner = getWeshGitSubcommandOwner({ rootDir: resolved.rootDir, filePath: resolved.sourcePath });
    const targetGitSubcommandOwner = getWeshGitSubcommandOwner({ rootDir: resolved.rootDir, filePath: resolved.targetPath });
    if (isForbiddenWeshGitLayerDependency({
      sourceLayer: sourceGitLayer,
      targetLayer: targetGitLayer,
      sourceSubcommandOwner: sourceGitSubcommandOwner,
      targetSubcommandOwner: targetGitSubcommandOwner,
    })) {
      context.report({
        node: reportNode ?? sourceNode,
        messageId: 'forbiddenWeshGitLayerDependency',
        data: { importPath, sourceLayer: sourceGitLayer, targetLayer: targetGitLayer },
      });
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
      forbiddenWeshCommandDependency: 'Wesh command {{sourceCommand}} must not depend directly on sibling command {{targetCommand}} through "{{importPath}}". Move intentionally shared behavior to a neutral shared/core layer, or keep independently evolving behavior command-local.',
      forbiddenWeshCommandRegistryDependency: 'Wesh command {{sourceCommand}} production code must not depend on the root command registry through "{{importPath}}". The registry is a composition root, not a command-facing shared API.',
      forbiddenWeshGitLayerDependency: 'Wesh Git {{sourceLayer}} code must not depend on another {{targetLayer}} owner through "{{importPath}}". Private modules may stay within one subcommand; behavior shared across subcommands belongs in a Git-owned domain module.',
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
