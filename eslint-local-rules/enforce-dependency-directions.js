import path from 'node:path';
import process from 'node:process';
import fs from 'node:fs';

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

  if (node?.type === 'TemplateLiteral') {
    let value = '';
    for (let index = 0; index < node.quasis.length; index++) {
      value += node.quasis[index]?.value.cooked ?? node.quasis[index]?.value.raw ?? '';
      if (index < node.expressions.length) {
        const expression = getStaticStringValue({ node: node.expressions[index] });
        if (expression === undefined) {
          return undefined;
        }
        value += expression;
      }
    }
    return value;
  }
  if (node?.type === 'BinaryExpression' && node.operator === '+') {
    const left = getStaticStringValue({ node: node.left });
    const right = getStaticStringValue({ node: node.right });
    return left === undefined || right === undefined ? undefined : left + right;
  }
  if (['ParenthesizedExpression', 'TSAsExpression', 'TSTypeAssertion', 'TSNonNullExpression', 'TSSatisfiesExpression'].includes(node?.type)) {
    return getStaticStringValue({ node: node.expression });
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

const cspMessageComposable = 'composables/useCspMessageHintsOnly';
const cspMessageConsumers = new Set([
  'components/csp/CspMessageHintContent.vue',
]);
const cspDeveloperConsumer = 'components/csp/DeveloperCspDiagnosticsContent.vue';
const cspDeploymentGuidanceConsumer = 'components/csp/CspDeploymentGuidance.vue';
const developmentMetaDirectory = 'logic/development-meta-csp';
const developmentMetaAdapter = 'composables/useDevelopmentMetaCspNotForSecurity';
const developmentMetaReadFacade = `${developmentMetaDirectory}/document-messages-only`;
const developmentMetaPrivacyBrokerSync = `${developmentMetaDirectory}/privacy-broker-sync`;
const privacyFetchBrokerClient = 'features/privacy-fetch/broker-client.ts';
const privacyFetchBrokerEntry = 'features/privacy-fetch/broker-entry.ts';
const privacyFetchDevelopmentMetaApplier = 'features/privacy-fetch/broker-development-meta-csp';
const developmentMetaRecoveryConsumer = 'components/csp/DevelopmentMetaCspRecoveryContent.vue';
const developmentMetaConsumers = new Set([cspDeveloperConsumer, developmentMetaRecoveryConsumer]);
const developmentMetaReadExports = [
  'getAppliedDevelopmentMetaCspForDocumentMessagesOnly',
  'subscribeDevelopmentMetaCspMessagesOnly',
];
const developmentMetaSettingOwners = new Set([
  '01-models/types.ts',
  '00-storage/mapper/mappers.ts',
  `${developmentMetaAdapter}.ts`,
]);
const cspMessageTypeConsumers = new Set([
  ...cspMessageConsumers,
  cspDeveloperConsumer,
  cspDeploymentGuidanceConsumer,
  'components/csp/CspMessageHint.vue',
  'components/csp/hint-copy.ts',
]);
const cspPrivateDisplayOwners = new Map([
  ['components/csp/CspMessageHintContent.vue', new Set(['components/csp/CspMessageHint.vue'])],
  ['components/csp/DeveloperCspDiagnosticsContent.vue', new Set(['components/DeveloperCspDiagnostics.vue'])],
  ['components/csp/DevelopmentMetaCspRecoveryContent.vue', new Set(['components/csp/DevelopmentMetaCspRecovery.vue'])],
  ['components/csp/DevelopmentMetaCspRecovery.vue', new Set(['components/AppAuxiliaryUi.vue'])],
  ['components/csp/hint-copy', new Set([...cspMessageConsumers, cspDeveloperConsumer, 'components/csp/CspHintDetails.vue', 'components/csp/CspMessageHintView.vue'])],
]);

function withoutScriptExtension({ relativePath }) {
  return relativePath.replace(/\.(?:[cm]?[jt]sx?)$/u, '');
}

function isDirectoryReference({ relativePath, directory }) {
  return relativePath === directory || relativePath.startsWith(`${directory}/`);
}

function isTypeOnlyReference({ node }) {
  if (node.type === 'TSImportType') {
    return true;
  }
  if (node.type !== 'ImportDeclaration') {
    return false;
  }
  return node.importKind === 'type' || (node.specifiers.length > 0
    && node.specifiers.every(specifier => specifier.type === 'ImportSpecifier' && specifier.importKind === 'type'));
}

function importsOnlyNamedCspComposables({ node, names }) {
  return node.type === 'ImportDeclaration' && node.specifiers.length > 0
    && node.specifiers.every(specifier => specifier.type === 'ImportSpecifier'
      && names.includes(specifier.imported.name ?? specifier.imported.value));
}

function importsOnlyCspMessageTypes({ node, source }) {
  const names = source === cspDeploymentGuidanceConsumer
    ? ['CspHintMessage']
    : ['CspHintTarget', 'CspHintMessage', 'CspHintDetail', 'CspSourceDescription'];
  if (node.type === 'TSImportType') {
    return node.qualifier?.type === 'Identifier' && names.includes(node.qualifier.name);
  }
  return importsOnlyNamedCspComposables({ node, names });
}

function developmentMetaDependencyDecision({ source, target, node }) {
  const sourceNative = isDirectoryReference({ relativePath: source, directory: developmentMetaDirectory });
  const sourceCore = isDirectoryReference({ relativePath: source, directory: 'logic/csp-message-hints' });
  const sourceWithoutExtension = withoutScriptExtension({ relativePath: source });
  const targetWithoutExtension = withoutScriptExtension({ relativePath: target });
  if (targetWithoutExtension === developmentMetaPrivacyBrokerSync) {
    return source === privacyFetchBrokerClient
      && importsOnlyNamedCspComposables({ node, names: ['getDevelopmentMetaCspPrivacyBrokerSyncNotForSecurity'] }) ? 'allowed' : 'forbidden';
  }
  if (isDirectoryReference({ relativePath: target, directory: developmentMetaDirectory })) {
    if (sourceNative) {
      if (sourceWithoutExtension === developmentMetaPrivacyBrokerSync) {
        if (targetWithoutExtension === `${developmentMetaDirectory}/types`) {
          return isTypeOnlyReference({ node })
            && importsOnlyNamedCspComposables({ node, names: ['DevelopmentMetaCspPrivacyBrokerStateNotForSecurity'] }) ? 'allowed' : 'forbidden';
        }
        return targetWithoutExtension === `${developmentMetaDirectory}/owner`
          && importsOnlyNamedCspComposables({ node, names: ['getDevelopmentMetaCspPrivacyBrokerSyncOwnerNotForSecurity'] }) ? 'allowed' : 'forbidden';
      }
      if (sourceWithoutExtension !== developmentMetaReadFacade) {
        return 'allowed';
      }
      if (targetWithoutExtension === `${developmentMetaDirectory}/types`) {
        return isTypeOnlyReference({ node }) ? 'allowed' : 'forbidden';
      }
      return [`${developmentMetaDirectory}/owner`, `${developmentMetaDirectory}/index`, developmentMetaDirectory].includes(targetWithoutExtension)
        && importsOnlyNamedCspComposables({ node, names: ['getDevelopmentMetaCspReadOnlyOwnerForMessagesOnly'] }) ? 'allowed' : 'forbidden';
    }
    if (sourceCore) {
      const readExports = source === 'logic/csp-message-hints/index.ts'
        ? [...developmentMetaReadExports, 'getDevelopmentMetaCspForNextPrivacyBrokerRequestHintsOnly']
        : developmentMetaReadExports;
      return targetWithoutExtension === developmentMetaReadFacade
        && importsOnlyNamedCspComposables({ node, names: readExports }) ? 'allowed' : 'forbidden';
    }
    if (sourceWithoutExtension === developmentMetaAdapter) {
      if (targetWithoutExtension === `${developmentMetaDirectory}/types`) {
        return isTypeOnlyReference({ node }) ? 'allowed' : 'forbidden';
      }
      return [`${developmentMetaDirectory}/owner`, `${developmentMetaDirectory}/index`, developmentMetaDirectory].includes(targetWithoutExtension)
        && importsOnlyNamedCspComposables({ node, names: ['getDevelopmentMetaCspOwnerNotForSecurity'] }) ? 'allowed' : 'forbidden';
    }
    return developmentMetaConsumers.has(source)
      && targetWithoutExtension === `${developmentMetaDirectory}/types`
      && isTypeOnlyReference({ node }) ? 'allowed' : 'forbidden';
  }
  if (targetWithoutExtension === developmentMetaAdapter) {
    return developmentMetaConsumers.has(source)
      && importsOnlyNamedCspComposables({ node, names: ['useDevelopmentMetaCspNotForSecurity'] }) ? 'allowed' : 'forbidden';
  }
  return 'unrelated';
}

function isForbiddenCspDependency({ rootDir, sourcePath, targetPath, node }) {
  const source = normalizePath({ filePath: path.relative(rootDir, sourcePath) });
  const target = normalizePath({ filePath: path.relative(rootDir, targetPath) });
  if (isTestSourceFile({ filePath: source }) || /\.test-support\.[cm]?[jt]sx?$/u.test(source)) {
    return false;
  }
  const sourceCore = isDirectoryReference({ relativePath: source, directory: 'logic/csp-message-hints' });
  const sourceParser = isDirectoryReference({ relativePath: source, directory: 'utils/csp' });
  const sourceNative = isDirectoryReference({ relativePath: source, directory: developmentMetaDirectory });
  const targetWithoutExtension = withoutScriptExtension({ relativePath: target });
  const developmentDecision = developmentMetaDependencyDecision({ source, target, node });
  if (developmentDecision !== 'unrelated') {
    return developmentDecision === 'forbidden';
  }
  if (targetWithoutExtension === privacyFetchDevelopmentMetaApplier) {
    return source !== privacyFetchBrokerEntry
      || !importsOnlyNamedCspComposables({ node, names: ['createBrokerDevelopmentMetaCspNotForSecurity'] });
  }
  if (((sourceCore && !isDirectoryReference({ relativePath: target, directory: 'logic/csp-message-hints' }))
    || (sourceNative && !isDirectoryReference({ relativePath: target, directory: developmentMetaDirectory })))
    && ['application', 'storage-service', 'storage-mapper', 'storage-dto'].includes(classifyPath({ rootDir, filePath: targetPath }))) {
    return true;
  }
  if (isDirectoryReference({ relativePath: target, directory: 'utils/csp' })) {
    const nativeParserOwner = source === `${developmentMetaDirectory}/owner.ts`
      || (source === `${developmentMetaDirectory}/types.ts` && isTypeOnlyReference({ node }));
    return !sourceParser && !sourceCore && !nativeParserOwner;
  }
  if (isDirectoryReference({ relativePath: target, directory: 'logic/csp-message-hints' })) {
    if (sourceCore) {
      return false;
    }
    if (withoutScriptExtension({ relativePath: source }) === cspMessageComposable) {
      return !['logic/csp-message-hints', 'logic/csp-message-hints/index', 'logic/csp-message-hints/types'].includes(targetWithoutExtension);
    }
    return targetWithoutExtension !== 'logic/csp-message-hints/types'
      || !cspMessageTypeConsumers.has(source)
      || !isTypeOnlyReference({ node })
      || (source !== cspDeveloperConsumer && !importsOnlyCspMessageTypes({ node, source }));
  }
  if (targetWithoutExtension === cspMessageComposable) {
    if (source === cspDeveloperConsumer) {
      return !importsOnlyNamedCspComposables({ node, names: ['useCspMessageHintsOnly', 'useCachedCspParseResultForDeveloperDisplayOnly'] });
    }
    return !cspMessageConsumers.has(source)
      || !importsOnlyNamedCspComposables({ node, names: ['useCspMessageHintsOnly'] });
  }
  const privateOwners = cspPrivateDisplayOwners.get(targetWithoutExtension)
    ?? cspPrivateDisplayOwners.get(`${targetWithoutExtension}.vue`);
  return privateOwners !== undefined && !privateOwners.has(source);
}

function propertyKeyName({ node, computed }) {
  return !computed && node?.type === 'Identifier' ? node.name : getStaticStringValue({ node });
}

function createDevelopmentMetaSettingReporter({ context }) {
  const source = resolveSourcePath({ context, filename: context.filename ?? context.getFilename?.() ?? '' });
  const sourcePath = source === undefined ? undefined : normalizePath({ filePath: path.relative(source.rootDir, source.sourcePath) });
  const permitted = sourcePath === undefined || developmentMetaSettingOwners.has(sourcePath)
    || isTestSourceFile({ filePath: sourcePath }) || /\.test-support\.[cm]?[jt]sx?$/u.test(sourcePath);
  return ({ node, key, computed }) => {
    if (permitted) {
      return;
    }
    const name = propertyKeyName({ node: key, computed });
    const rawExperimentalField = name === 'metaCsp' && node.type === 'MemberExpression'
      && node.object.type === 'MemberExpression'
      && propertyKeyName({ node: node.object.property, computed: node.object.computed }) === 'experimental';
    if (name === 'metaCspForDevelopmentNotForSecurity' || rawExperimentalField) {
      context.report({ node, messageId: 'forbiddenDevelopmentMetaCspSetting' });
    }
  };
}

function resolveGlobPattern({ context, filename, importPath }) {
  const source = resolveSourcePath({ context, filename });
  if (source === undefined) {
    return undefined;
  }
  const [rawOptions = {}] = context.options;
  const aliasPrefixes = rawOptions.aliasPrefixes ?? ['@', '~'];
  const aliasPrefix = aliasPrefixes.find(candidate => importPath.startsWith(`${candidate}/`));
  if (aliasPrefix !== undefined) {
    return normalizePath({ filePath: path.resolve(source.rootDir, importPath.slice(aliasPrefix.length + 1)) });
  }
  if (importPath.startsWith('./') || importPath.startsWith('../')) {
    return normalizePath({ filePath: path.resolve(path.dirname(source.sourcePath), importPath) });
  }
  return undefined;
}

function cspProtectedPaths({ rootDir }) {
  const paths = new Set([
    'utils/csp/index.ts',
    'utils/csp/types.ts',
    'logic/csp-message-hints/index.ts',
    'logic/csp-message-hints/types.ts',
    'logic/csp-message-hints/observation.ts',
    `${developmentMetaDirectory}/index.ts`,
    `${developmentMetaDirectory}/owner.ts`,
    `${developmentMetaDirectory}/types.ts`,
    `${developmentMetaReadFacade}.ts`,
    `${developmentMetaPrivacyBrokerSync}.ts`,
    `${privacyFetchDevelopmentMetaApplier}.ts`,
    `${developmentMetaAdapter}.ts`,
    `${cspMessageComposable}.ts`,
    ...[...cspPrivateDisplayOwners.keys()].map(file => path.extname(file) === '' ? `${file}.ts` : file),
  ]);
  for (const directory of ['utils/csp', 'logic/csp-message-hints', developmentMetaDirectory]) {
    const absoluteDirectory = path.join(rootDir, directory);
    if (!fs.existsSync(absoluteDirectory)) {
      continue;
    }
    for (const entry of fs.readdirSync(absoluteDirectory, { recursive: true, withFileTypes: true })) {
      if (entry.isFile()) {
        paths.add(normalizePath({ filePath: path.relative(rootDir, path.join(entry.parentPath, entry.name)) }));
      }
    }
  }
  return [...paths].map(relativePath => path.join(rootDir, relativePath));
}

function forbiddenCspGlobPath({ context, filename, node }) {
  const source = resolveSourcePath({ context, filename });
  if (source === undefined) {
    return undefined;
  }
  const patterns = getImportMetaGlobSourceNodes({ node }).map(sourceNode => getStaticStringValue({ node: sourceNode }));
  const included = [], excluded = [];
  for (const pattern of patterns) {
    if (pattern === undefined) {
      continue;
    }
    const negative = pattern.startsWith('!');
    const resolved = resolveGlobPattern({ context, filename, importPath: negative ? pattern.slice(1) : pattern });
    if (resolved !== undefined) {
      (negative ? excluded : included).push(resolved);
    }
  }
  for (const targetPath of cspProtectedPaths({ rootDir: source.rootDir })) {
    const normalizedTarget = normalizePath({ filePath: targetPath });
    if (included.some(pattern => path.matchesGlob(normalizedTarget, pattern))
      && !excluded.some(pattern => path.matchesGlob(normalizedTarget, pattern))
      && isForbiddenCspDependency({ rootDir: source.rootDir, sourcePath: source.sourcePath, targetPath, node })) {
      return normalizePath({ filePath: path.relative(source.rootDir, targetPath) });
    }
  }
  return undefined;
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

  function checkSourceNode({ sourceNode, reportNode, cspOnly }) {
    const importPath = getStaticStringValue({ node: sourceNode });
    if (importPath === undefined) {
      return;
    }

    const resolved = resolveImportPath({ context, filename, importPath });
    if (resolved === undefined) {
      return;
    }

    if (!(reportNode?.type === 'CallExpression' && isImportMetaMember({ node: reportNode.callee, propertyName: 'glob' }))
      && isForbiddenCspDependency({ ...resolved, node: reportNode ?? sourceNode })) {
      context.report({
        node: reportNode ?? sourceNode,
        messageId: 'forbiddenCspDisplayDependency',
        data: { importPath },
      });
      return;
    }
    if (cspOnly) {
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
      forbiddenCspDisplayDependency: 'CSP observations are display-only. "{{importPath}}" is private to the CSP parser, message owner, or its dedicated display adapter; never use it to control application behavior.',
      forbiddenDevelopmentMetaCspSetting: 'The development-only meta CSP setting belongs to persistence and its dedicated Developer/recovery adapter. Do not read or write it to control application features or security.',
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
    const checkDevelopmentSetting = createDevelopmentMetaSettingReporter({ context });
    function checkCspGlob({ node }) {
      if (!isImportMetaMember({ node: node.callee, propertyName: 'glob' })) {
        return false;
      }
      const forbiddenCspPath = forbiddenCspGlobPath({ context, filename: context.filename ?? context.getFilename?.() ?? '', node });
      if (forbiddenCspPath === undefined) {
        return false;
      }
      context.report({ node, messageId: 'forbiddenCspDisplayDependency', data: { importPath: forbiddenCspPath } });
      return true;
    }

    const visitors = {
      MemberExpression(node) {
        checkDevelopmentSetting({ node, key: node.property, computed: node.computed });
      },
      Property(node) {
        checkDevelopmentSetting({ node, key: node.key, computed: node.computed });
      },
      TSPropertySignature(node) {
        checkDevelopmentSetting({ node, key: node.key, computed: node.computed });
      },
      TSIndexedAccessType(node) {
        if (node.indexType.type === 'TSLiteralType') {
          checkDevelopmentSetting({ node, key: node.indexType.literal, computed: true });
        }
      },
      ImportDeclaration(node) {
        checkSourceNode({ sourceNode: node.source, reportNode: node, cspOnly: false });
      },
      ExportNamedDeclaration(node) {
        if (node.source) {
          checkSourceNode({ sourceNode: node.source, reportNode: node, cspOnly: false });
        }
      },
      ExportAllDeclaration(node) {
        checkSourceNode({ sourceNode: node.source, reportNode: node, cspOnly: false });
      },
      ImportExpression(node) {
        checkSourceNode({ sourceNode: node.source, reportNode: node, cspOnly: false });
      },
      TSImportType(node) {
        checkSourceNode({ sourceNode: node.source ?? node.argument, reportNode: node, cspOnly: false });
      },
      CallExpression(node) {
        if (checkCspGlob({ node })) {
          return;
        }
        const sourceNode = getCallSourceNode({ node });
        if (sourceNode) {
          checkSourceNode({ sourceNode, reportNode: node, cspOnly: false });
        }
        for (const globSourceNode of getImportMetaGlobSourceNodes({ node })) {
          checkSourceNode({ sourceNode: globSourceNode, reportNode: node, cspOnly: false });
        }
      },
      NewExpression(node) {
        const sourceNode = getUrlSourceNode({ node });
        if (sourceNode) {
          checkSourceNode({ sourceNode, reportNode: node, cspOnly: false });
        }
      },
    };
    const sourceCode = context.sourceCode ?? context.getSourceCode();
    return sourceCode.parserServices?.defineTemplateBodyVisitor
      ? sourceCode.parserServices.defineTemplateBodyVisitor({
        MemberExpression: visitors.MemberExpression,
        Property: visitors.Property,
        ImportExpression(node) {
          checkSourceNode({ sourceNode: node.source, reportNode: node, cspOnly: true });
        },
        CallExpression(node) {
          if (checkCspGlob({ node })) {
            return;
          }
          const sourceNode = getCallSourceNode({ node });
          if (sourceNode) {
            checkSourceNode({ sourceNode, reportNode: node, cspOnly: true });
          }
        },
        NewExpression(node) {
          const sourceNode = getUrlSourceNode({ node });
          if (sourceNode) {
            checkSourceNode({ sourceNode, reportNode: node, cspOnly: true });
          }
        },
      }, visitors)
      : visitors;
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
