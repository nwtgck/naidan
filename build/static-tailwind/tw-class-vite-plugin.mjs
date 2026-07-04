import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  collectTwCandidateOccurrencesFromVueSource,
  transformTwCallsInModule,
  transformTwCallsInVueSource,
} from './tw-class-core.mjs';
import {
  analyzeSourceModules,
  createSourceModuleAnalysisCache,
  isStaticTailwindSourceFile,
  serializeSourceAnalysis,
} from './source-module-analyzer.mjs';
import {
  createCssOwnerKey,
  createCssOwnershipPlan,
  parseCssOwnerKey,
  serializeCssOwnershipPlan,
  writeCssOwnershipDebugFiles,
} from './css-ownership-planner.mjs';
import {
  createTailwindCssRegistrationModuleSource,
  createTailwindCssRuntimeModuleSource,
} from './tailwind-css-runtime-source.mjs';

const virtualMacroModuleId = 'virtual:naidan-tailwind';
const resolvedVirtualMacroModuleId = '\0virtual:naidan-tailwind';
const virtualCssPrefix = 'virtual:naidan-tailwind-css-module/';
const virtualCssRuntimeModuleId = 'virtual:naidan-tailwind-css-runtime';
const resolvedVirtualCssRuntimeModuleId = '\0virtual:naidan-tailwind-css-runtime';
const virtualHmrClientModuleId = 'virtual:naidan-tailwind-hmr-client';
const resolvedVirtualHmrClientModuleId = '\0virtual:naidan-tailwind-hmr-client';
const supportedModuleExtensions = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']);

function assertExistingPath({ label, filename, expectedType }) {
  let stats;
  try {
    stats = fs.statSync(filename);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new Error(`[tw-class] ${label} does not exist: ${filename}`, { cause: error });
    }
    throw error;
  }
  const matches = expectedType === 'directory' ? stats.isDirectory() : stats.isFile();
  if (!matches) throw new Error(`[tw-class] ${label} must be a ${expectedType}: ${filename}`);
}

function readExpectedTailwindVersion({ projectRoot }) {
  const packageJson = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
  const version = packageJson.devDependencies?.tailwindcss ?? packageJson.dependencies?.tailwindcss;
  if (version === undefined || !/^\d+\.\d+\.\d+$/u.test(version)) {
    throw new Error('[tw-class] tailwindcss must be pinned to an exact version in package.json.');
  }
  return version;
}

function groupHash({ ownerKey }) {
  return crypto.createHash('sha256').update(ownerKey).digest('hex');
}

function fileContentFingerprint({ filename }) {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
  } catch (error) {
    if (error?.code === 'ENOENT') return 'missing';
    throw error;
  }
}

function isPathInside({ directory, candidate }) {
  const relativePath = path.relative(path.resolve(directory), path.resolve(candidate));
  return relativePath === ''
    || (!path.isAbsolute(relativePath) && relativePath !== '..' && !relativePath.startsWith(`..${path.sep}`));
}

function assertPathDoesNotTraverseSymlinks({ root, target, label }) {
  const relativeParts = path.relative(root, target).split(path.sep).filter(Boolean);
  let current = root;
  for (const part of relativeParts) {
    current = path.join(current, part);
    let stats;
    try {
      stats = fs.lstatSync(current);
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }
    if (stats.isSymbolicLink()) {
      throw new Error(`[tw-class] ${label} must not traverse symbolic links: ${current}`);
    }
  }
}

function cleanModuleId({ id }) {
  return id.split('?', 1)[0];
}

function bundleModuleMatchesFile({ moduleId, filename, projectRoot }) {
  const cleanId = cleanModuleId({ id: moduleId });
  if (cleanId.startsWith('\0')) return false;
  const absoluteFilename = path.resolve(filename);
  const projectRelativeId = `/${path.relative(projectRoot, absoluteFilename).replaceAll(path.sep, '/')}`;
  if (cleanId === projectRelativeId) return true;
  if (path.isAbsolute(cleanId)) return path.resolve(cleanId) === absoluteFilename;
  return cleanId.endsWith(projectRelativeId);
}

function canonicalVirtualModuleId({ moduleId }) {
  const cleanId = cleanModuleId({ id: moduleId });
  if (cleanId.startsWith('\0virtual:naidan-tailwind-')) return cleanId;
  if (cleanId.startsWith('virtual:naidan-tailwind-')) return `\0${cleanId}`;
  return undefined;
}

export function assertCssRegistrationBundleIntegrity({
  bundle,
  projectRoot,
  importsByModule,
  moduleSourceByResolvedId,
  registrationDependenciesByResolvedId,
}) {
  const chunks = Object.entries(bundle)
    .filter(([, output]) => output.type === 'chunk')
    .map(([bundleName, chunk]) => ({
      chunk,
      fileName: chunk.fileName ?? bundleName,
    }));
  const chunkByFileName = new Map(chunks.map(({ fileName, chunk }) => [fileName, chunk]));
  const emittedModuleCounts = new Map();
  const chunkNamesByModuleId = new Map();
  for (const { fileName, chunk } of chunks) {
    for (const moduleId of Object.keys(chunk.modules ?? {})) {
      const canonicalId = canonicalVirtualModuleId({ moduleId }) ?? moduleId;
      emittedModuleCounts.set(canonicalId, (emittedModuleCounts.get(canonicalId) ?? 0) + 1);
      const chunkNames = chunkNamesByModuleId.get(canonicalId) ?? new Set();
      chunkNames.add(fileName);
      chunkNamesByModuleId.set(canonicalId, chunkNames);
    }
  }

  function resolveImportedChunkName({ importerFileName, importedFileName }) {
    if (chunkByFileName.has(importedFileName)) return importedFileName;
    const relativeName = path.posix.normalize(path.posix.join(
      path.posix.dirname(importerFileName),
      importedFileName,
    ));
    return chunkByFileName.has(relativeName) ? relativeName : undefined;
  }

  function reachableChunkNames({ roots, includeDynamicImports }) {
    const reachable = new Set();
    const queue = [...roots];
    while (queue.length > 0) {
      const fileName = queue.shift();
      if (fileName === undefined || reachable.has(fileName)) continue;
      reachable.add(fileName);
      const chunk = chunkByFileName.get(fileName);
      if (chunk === undefined) continue;
      const importedFileNames = includeDynamicImports
        ? [...(chunk.imports ?? []), ...(chunk.dynamicImports ?? [])]
        : chunk.imports ?? [];
      for (const importedFileName of importedFileNames) {
        const resolved = resolveImportedChunkName({ importerFileName: fileName, importedFileName });
        if (resolved !== undefined && !reachable.has(resolved)) queue.push(resolved);
      }
    }
    return reachable;
  }

  const entryChunkNames = chunks
    .filter(({ chunk }) => chunk.isEntry === true || chunk.isImplicitEntry === true)
    .map(({ fileName }) => fileName);
  const initialChunkNamesByEntry = new Map(entryChunkNames.map((entryChunkName) => [
    entryChunkName,
    reachableChunkNames({ roots: [entryChunkName], includeDynamicImports: false }),
  ]));
  const allChunkNamesByEntry = new Map(entryChunkNames.map((entryChunkName) => [
    entryChunkName,
    reachableChunkNames({ roots: [entryChunkName], includeDynamicImports: true }),
  ]));
  const staticallyReachableByChunkName = new Map();
  function registrationLoadsWithChunk({ ownerChunkName, registrationChunkName }) {
    let staticallyReachable = staticallyReachableByChunkName.get(ownerChunkName);
    if (staticallyReachable === undefined) {
      staticallyReachable = reachableChunkNames({ roots: [ownerChunkName], includeDynamicImports: false });
      staticallyReachableByChunkName.set(ownerChunkName, staticallyReachable);
    }
    if (staticallyReachable.has(registrationChunkName)) return true;

    const ownerEntryChunkNames = entryChunkNames.filter((entryChunkName) => (
      allChunkNamesByEntry.get(entryChunkName)?.has(ownerChunkName) === true
    ));
    return ownerEntryChunkNames.length > 0 && ownerEntryChunkNames.every((entryChunkName) => (
      initialChunkNamesByEntry.get(entryChunkName)?.has(registrationChunkName) === true
    ));
  }

  const directExpectedResolvedIds = new Set();
  const ownerChunkNamesByRegistrationId = new Map();
  for (const [filename, publicIds] of importsByModule) {
    const ownerChunkNames = chunks
      .filter(({ chunk }) => Object.keys(chunk.modules ?? {}).some((moduleId) => bundleModuleMatchesFile({
        moduleId,
        filename,
        projectRoot,
      })))
      .map(({ fileName }) => fileName);
    if (ownerChunkNames.length === 0) continue;
    for (const publicId of publicIds) {
      if (!publicId.startsWith(virtualCssPrefix)) continue;
      const resolvedId = `\0${publicId}`;
      directExpectedResolvedIds.add(resolvedId);
      const values = ownerChunkNamesByRegistrationId.get(resolvedId) ?? new Set();
      for (const ownerChunkName of ownerChunkNames) values.add(ownerChunkName);
      ownerChunkNamesByRegistrationId.set(resolvedId, values);
    }
  }

  const expectedResolvedIds = new Set();
  const pendingRegistrations = [...directExpectedResolvedIds].flatMap((registrationId) => (
    [...(ownerChunkNamesByRegistrationId.get(registrationId) ?? [])]
      .map((ownerChunkName) => ({ registrationId, ownerChunkName }))
  ));
  const visitedRegistrationOwners = new Set();
  for (let index = 0; index < pendingRegistrations.length; index += 1) {
    const pending = pendingRegistrations[index];
    if (pending === undefined) continue;
    const pairKey = `${pending.registrationId}\0${pending.ownerChunkName}`;
    if (visitedRegistrationOwners.has(pairKey)) continue;
    visitedRegistrationOwners.add(pairKey);
    expectedResolvedIds.add(pending.registrationId);
    const values = ownerChunkNamesByRegistrationId.get(pending.registrationId) ?? new Set();
    values.add(pending.ownerChunkName);
    ownerChunkNamesByRegistrationId.set(pending.registrationId, values);
    for (const dependencyId of registrationDependenciesByResolvedId.get(pending.registrationId) ?? []) {
      pendingRegistrations.push({
        registrationId: dependencyId,
        ownerChunkName: pending.ownerChunkName,
      });
    }
  }

  const emittedRegistrationIds = [...emittedModuleCounts.keys()]
    .filter((moduleId) => moduleId.startsWith(`\0${virtualCssPrefix}`));
  const missing = [...expectedResolvedIds].filter((moduleId) => (emittedModuleCounts.get(moduleId) ?? 0) === 0);
  const duplicate = [...expectedResolvedIds].filter((moduleId) => (emittedModuleCounts.get(moduleId) ?? 0) > 1);
  const unexpected = emittedRegistrationIds.filter((moduleId) => !expectedResolvedIds.has(moduleId));
  const unknownPlannedIds = [...expectedResolvedIds].filter((moduleId) => !moduleSourceByResolvedId.has(moduleId));
  const misplaced = [];
  for (const [registrationId, ownerChunkNames] of ownerChunkNamesByRegistrationId) {
    const registrationChunkNames = chunkNamesByModuleId.get(registrationId) ?? new Set();
    if (registrationChunkNames.size !== 1) continue;
    const [registrationChunkName] = registrationChunkNames;
    for (const ownerChunkName of ownerChunkNames) {
      if (!registrationLoadsWithChunk({ ownerChunkName, registrationChunkName })) {
        misplaced.push(`${registrationId} is not loaded with ${ownerChunkName}`);
      }
    }
  }

  const runtimeCount = emittedModuleCounts.get(resolvedVirtualCssRuntimeModuleId) ?? 0;
  const runtimeInvalid = expectedResolvedIds.size === 0 ? runtimeCount !== 0 : runtimeCount !== 1;
  if (!runtimeInvalid && runtimeCount === 1) {
    const [runtimeChunkName] = chunkNamesByModuleId.get(resolvedVirtualCssRuntimeModuleId) ?? [];
    if (runtimeChunkName !== undefined) {
      for (const registrationId of expectedResolvedIds) {
        const [registrationChunkName] = chunkNamesByModuleId.get(registrationId) ?? [];
        if (
          registrationChunkName !== undefined
          && !registrationLoadsWithChunk({
            ownerChunkName: registrationChunkName,
            registrationChunkName: runtimeChunkName,
          })
        ) misplaced.push(`${resolvedVirtualCssRuntimeModuleId} is not loaded with ${registrationChunkName}`);
      }
    }
  }

  if (
    missing.length === 0
    && duplicate.length === 0
    && unexpected.length === 0
    && unknownPlannedIds.length === 0
    && misplaced.length === 0
    && !runtimeInvalid
  ) return;

  const details = [
    missing.length === 0 ? undefined : `missing registrations: ${missing.join(', ')}`,
    duplicate.length === 0 ? undefined : `registrations not emitted exactly once: ${duplicate.join(', ')}`,
    unexpected.length === 0 ? undefined : `unexpected registrations: ${unexpected.join(', ')}`,
    unknownPlannedIds.length === 0 ? undefined : `registrations missing from the active plan: ${unknownPlannedIds.join(', ')}`,
    misplaced.length === 0 ? undefined : `registrations not loaded with their owners: ${misplaced.join(', ')}`,
    runtimeInvalid ? `runtime module emission count was ${runtimeCount}, expected ${expectedResolvedIds.size === 0 ? 0 : 1}` : undefined,
  ].filter(Boolean);
  throw new Error(`[tw-class] Production CSS registration integrity failed: ${details.join('; ')}`);
}

export function createTwClassVitePlugin({
  projectRoot,
  sourceRoot,
  entryModule,
  tailwindCssPath,
  debugOutputDirectory,
  outputMode,
  cssPlanning,
  maxSplitCssGroups,
}) {
  if (outputMode !== 'single' && outputMode !== 'split') {
    throw new Error(`[tw-class] Unknown CSS output mode: ${String(outputMode)}`);
  }
  if (cssPlanning !== 'enabled' && cssPlanning !== 'disabled') {
    throw new Error(`[tw-class] Unknown CSS planning mode: ${String(cssPlanning)}`);
  }
  if (maxSplitCssGroups !== undefined && (!Number.isInteger(maxSplitCssGroups) || maxSplitCssGroups < 0)) {
    throw new Error(`[tw-class] maxSplitCssGroups must be a non-negative integer or undefined: ${String(maxSplitCssGroups)}`);
  }
  const splitCss = outputMode === 'split';
  const absoluteProjectRoot = path.resolve(projectRoot);
  const absoluteSourceRoot = path.resolve(sourceRoot);
  const absoluteEntryModule = path.resolve(entryModule);
  const absoluteTailwindCssPath = path.resolve(tailwindCssPath);
  assertExistingPath({ label: 'projectRoot', filename: absoluteProjectRoot, expectedType: 'directory' });
  assertExistingPath({ label: 'sourceRoot', filename: absoluteSourceRoot, expectedType: 'directory' });
  assertExistingPath({ label: 'entryModule', filename: absoluteEntryModule, expectedType: 'file' });
  assertExistingPath({ label: 'tailwindCssPath', filename: absoluteTailwindCssPath, expectedType: 'file' });
  const absoluteDebugOutputDirectory = debugOutputDirectory === undefined
    ? undefined
    : path.resolve(debugOutputDirectory);
  const debugOutputRelativeParts = absoluteDebugOutputDirectory === undefined
    ? []
    : path.relative(absoluteProjectRoot, absoluteDebugOutputDirectory).split(path.sep);
  if (
    absoluteDebugOutputDirectory !== undefined
    && (
      path.isAbsolute(path.relative(absoluteProjectRoot, absoluteDebugOutputDirectory))
      || debugOutputRelativeParts[0] === '..'
      || debugOutputRelativeParts.length < 2
      || !debugOutputRelativeParts[0].startsWith('dist')
    )
  ) {
    throw new Error(
      '[tw-class] debugOutputDirectory must be a dedicated child directory under a projectRoot/dist* build directory: '
      + absoluteDebugOutputDirectory,
    );
  }
  if (absoluteDebugOutputDirectory !== undefined) {
    assertPathDoesNotTraverseSymlinks({
      root: absoluteProjectRoot,
      target: absoluteDebugOutputDirectory,
      label: 'debugOutputDirectory',
    });
  }
  const expectedTailwindVersion = readExpectedTailwindVersion({ projectRoot: absoluteProjectRoot });
  let command = 'build';
  let environmentName = 'client';
  const sourceAnalysisCache = createSourceModuleAnalysisCache();
  let analysis;
  let plan;
  let entryCss = '';
  let moduleSourceByResolvedId = new Map();
  let registrationDependenciesByResolvedId = new Map();
  let importsByModule = new Map();
  let ownerRootByName = new Map();
  const retiredCssModuleIds = new Set();
  let refreshQueue = Promise.resolve();
  const refreshPromisesByKey = new Map();

  function buildVirtualState({ nextAnalysis, nextPlan }) {
    if (!splitCss) {
      return {
        nextModuleSourceByResolvedId: new Map(),
        nextRegistrationDependenciesByResolvedId: new Map(),
        nextImportsByModule: new Map(),
        nextOwnerRootByName: new Map([['initial', absoluteEntryModule]]),
      };
    }
    const nextModuleSourceByResolvedId = new Map();
    const nextRegistrationDependenciesByResolvedId = new Map();
    const nextImportsByModule = new Map();
    const nextOwnerRootByName = new Map([['initial', absoluteEntryModule]]);
    for (const owner of nextAnalysis.cssOwners) nextOwnerRootByName.set(owner.name, owner.root);

    const registrations = [];
    for (const [ownerKey, fragments] of nextPlan.runtimeFragmentsByOwner) {
      if (fragments.length === 0) continue;
      const normalizedOwners = parseCssOwnerKey({ key: ownerKey });
      const owners = normalizedOwners.length === 0 ? ['initial'] : normalizedOwners;
      const publicId = `${virtualCssPrefix}${groupHash({ ownerKey: createCssOwnerKey({ owners }) })}.js`;
      const resolvedId = `\0${publicId}`;
      registrations.push({
        fragments,
        owners,
        publicId,
        resolvedId,
      });
      for (const owner of owners) {
        const root = nextOwnerRootByName.get(owner);
        if (root === undefined) throw new Error(`[tw-class] CSS owner has no module root: ${owner}`);
        const values = nextImportsByModule.get(root) ?? new Set();
        values.add(publicId);
        nextImportsByModule.set(root, values);
      }
    }
    const initialRegistrationPublicId = registrations.find(({ owners }) => (
      owners.length === 1 && owners[0] === 'initial'
    ))?.publicId;
    for (const registration of registrations) {
      const isInitial = registration.owners.length === 1 && registration.owners[0] === 'initial';
      nextModuleSourceByResolvedId.set(
        registration.resolvedId,
        createTailwindCssRegistrationModuleSource({
          moduleId: registration.resolvedId,
          fragments: registration.fragments.map(({ order, css }) => [order, css]),
          runtimeModuleId: virtualCssRuntimeModuleId,
          dependencyModuleIds: isInitial || initialRegistrationPublicId === undefined
            ? []
            : [initialRegistrationPublicId],
        }),
      );
      const initialRegistrationResolvedId = initialRegistrationPublicId === undefined
        ? undefined
        : `\0${initialRegistrationPublicId}`;
      nextRegistrationDependenciesByResolvedId.set(
        registration.resolvedId,
        isInitial || initialRegistrationResolvedId === undefined
          ? []
          : [initialRegistrationResolvedId],
      );
    }
    if (command === 'serve') {
      const entryImports = nextImportsByModule.get(absoluteEntryModule) ?? new Set();
      entryImports.add(virtualHmrClientModuleId);
      nextImportsByModule.set(absoluteEntryModule, entryImports);
    }
    return {
      nextModuleSourceByResolvedId,
      nextRegistrationDependenciesByResolvedId,
      nextImportsByModule: new Map([...nextImportsByModule].map(([file, values]) => [file, [...values].sort()])),
      nextOwnerRootByName,
    };
  }

  async function refreshPlan() {
    const nextAnalysis = analyzeSourceModules({
      projectRoot: absoluteProjectRoot,
      sourceRoot: absoluteSourceRoot,
      ownershipMode: splitCss ? 'source-module' : 'single-css',
      cache: sourceAnalysisCache,
    });
    const nextPlan = await createCssOwnershipPlan({
      projectRoot: absoluteProjectRoot,
      cssEntryPath: absoluteTailwindCssPath,
      expectedTailwindVersion,
      analysis: nextAnalysis,
      outputMode,
      maxSplitCssGroups,
    });
    const state = buildVirtualState({ nextAnalysis, nextPlan });
    const previousModuleSourceByResolvedId = moduleSourceByResolvedId;
    const previousImportsByModule = importsByModule;
    const previousEntryCss = entryCss;
    const hadPreviousPlan = plan !== undefined;
    analysis = nextAnalysis;
    plan = nextPlan;
    entryCss = nextPlan.entryCss;
    for (const id of previousModuleSourceByResolvedId.keys()) {
      if (!state.nextModuleSourceByResolvedId.has(id)) retiredCssModuleIds.add(id);
    }
    for (const id of state.nextModuleSourceByResolvedId.keys()) retiredCssModuleIds.delete(id);
    moduleSourceByResolvedId = state.nextModuleSourceByResolvedId;
    registrationDependenciesByResolvedId = state.nextRegistrationDependenciesByResolvedId;
    importsByModule = state.nextImportsByModule;
    ownerRootByName = state.nextOwnerRootByName;

    const changedCssIds = new Set([...previousModuleSourceByResolvedId.keys(), ...moduleSourceByResolvedId.keys()].filter((id) => previousModuleSourceByResolvedId.get(id) !== moduleSourceByResolvedId.get(id)));
    const removedCssIds = new Set([...previousModuleSourceByResolvedId.keys()].filter((id) => !moduleSourceByResolvedId.has(id)));
    const changedOwnerModules = new Set([...previousImportsByModule.keys(), ...importsByModule.keys()].filter((id) => (
      JSON.stringify(previousImportsByModule.get(id) ?? []) !== JSON.stringify(importsByModule.get(id) ?? [])
    )));
    return {
      baseCssChanged: hadPreviousPlan && previousEntryCss !== entryCss,
      changedCssIds,
      removedCssIds,
      changedOwnerModules,
    };
  }

  function scheduleRefresh({ key }) {
    const existing = refreshPromisesByKey.get(key);
    if (existing !== undefined) return existing;
    const promise = refreshQueue.then(
      () => refreshPlan(),
      () => refreshPlan(),
    );
    refreshPromisesByKey.set(key, promise);
    refreshQueue = promise.then(
      () => undefined,
      () => undefined,
    );
    promise.then(
      () => {
        if (refreshPromisesByKey.get(key) === promise) refreshPromisesByKey.delete(key);
      },
      () => {
        if (refreshPromisesByKey.get(key) === promise) refreshPromisesByKey.delete(key);
      },
    );
    return promise;
  }

  function clearDebugOutput() {
    if (absoluteDebugOutputDirectory === undefined) return;
    fs.rmSync(absoluteDebugOutputDirectory, { recursive: true, force: true });
  }

  function writeDebugOutput() {
    if (absoluteDebugOutputDirectory === undefined || analysis === undefined || plan === undefined) return;
    fs.mkdirSync(absoluteDebugOutputDirectory, { recursive: true });
    fs.writeFileSync(path.join(absoluteDebugOutputDirectory, 'source-analysis.json'), `${JSON.stringify(serializeSourceAnalysis({ analysis }), null, 2)}\n`);
    fs.writeFileSync(path.join(absoluteDebugOutputDirectory, 'ownership-plan.json'), `${JSON.stringify(serializeCssOwnershipPlan({ plan }), null, 2)}\n`);
    writeCssOwnershipDebugFiles({ directory: path.join(absoluteDebugOutputDirectory, 'css-groups'), plan });
  }

  return {
    name: 'naidan-tailwind-static-virtual-css',
    enforce: 'pre',
    configResolved(config) {
      command = config.command;
      environmentName = 'client';
    },
    async buildStart() {
      if (cssPlanning === 'disabled') return;
      if (command === 'build') clearDebugOutput();
      await refreshPlan();
      this.info(splitCss
        ? `[tw-class] planned ${plan.candidates.length} candidates into ${plan.cssGroups.size} virtual CSS ownership groups.`
        : `[tw-class] planned ${plan.candidates.length} candidates into one global CSS asset.`);
    },
    generateBundle: {
      order: 'post',
      handler(_options, bundle) {
        if (cssPlanning !== 'enabled' || command !== 'build' || !splitCss) return;
        assertCssRegistrationBundleIntegrity({
          bundle,
          projectRoot: absoluteProjectRoot,
          importsByModule,
          moduleSourceByResolvedId,
          registrationDependenciesByResolvedId,
        });
      },
    },
    writeBundle() {
      if (cssPlanning === 'enabled' && command === 'build') writeDebugOutput();
    },
    resolveId(id) {
      if (id === virtualMacroModuleId) return resolvedVirtualMacroModuleId;
      if (id === virtualHmrClientModuleId) return resolvedVirtualHmrClientModuleId;
      if (id === virtualCssRuntimeModuleId) return resolvedVirtualCssRuntimeModuleId;
      if (id.startsWith(virtualCssPrefix)) return `\0${id}`;
      return null;
    },
    load(id) {
      if (id === resolvedVirtualHmrClientModuleId) {
        return `import { unregisterTailwindCssModules } from ${JSON.stringify(virtualCssRuntimeModuleId)};
if (import.meta.hot) {
  import.meta.hot.on('naidan-tailwind:retire-css', ({ moduleIds }) => {
    unregisterTailwindCssModules({ moduleIds });
  });
}`;
      }
      if (id === resolvedVirtualCssRuntimeModuleId) return createTailwindCssRuntimeModuleSource();
      if (id === resolvedVirtualMacroModuleId) {
        return "const fail = () => { throw new Error('Tailwind compile-time macro was not transformed.'); }; export const tw = fail; export const twClassString = fail; export const twClasses = fail; export const customClasses = fail;";
      }
      if (moduleSourceByResolvedId.has(id)) return moduleSourceByResolvedId.get(id);
      if (retiredCssModuleIds.has(id)) return 'export {};';
      const cleanId = id.split('?', 1)[0];
      if (path.resolve(cleanId) === absoluteTailwindCssPath) return entryCss;
      return null;
    },
    transform(source, id) {
      const cleanId = id.split('?', 1)[0];
      if (cleanId.includes('/node_modules/')) return null;
      const imports = importsByModule.get(path.resolve(cleanId)) ?? [];
      const referencesMacroModule = source.includes(virtualMacroModuleId);
      const isRawVueModule = cleanId.endsWith('.vue') && !id.includes('?');
      if (
        cssPlanning === 'enabled'
        && isRawVueModule
        && source.includes('tw-')
        && !isStaticTailwindSourceFile({ filename: cleanId, sourceRoot: absoluteSourceRoot })
      ) {
        const occurrences = collectTwCandidateOccurrencesFromVueSource({ source, filename: cleanId });
        if (occurrences.length > 0) {
          throw new Error(
            '[tw-class] Vue Tailwind attributes are only supported in production source files covered by static analysis: '
            + cleanId,
          );
        }
      }
      if (imports.length === 0 && !referencesMacroModule) return null;
      const assertCoveredMacroTransform = ({ changed }) => {
        if (
          cssPlanning === 'enabled'
          && referencesMacroModule
          && changed
          && !isStaticTailwindSourceFile({ filename: cleanId, sourceRoot: absoluteSourceRoot })
        ) {
          throw new Error(
            '[tw-class] Compile-time Tailwind macros are only supported in production source files covered by static analysis: '
            + cleanId,
          );
        }
      };
      if (isRawVueModule) {
        const result = transformTwCallsInVueSource({ source, filename: cleanId, additionalImports: imports });
        assertCoveredMacroTransform({ changed: result.changed });
        return result.changed ? { code: result.code, map: result.map } : null;
      }
      const extension = path.extname(cleanId);
      if (!supportedModuleExtensions.has(extension)) return null;
      const result = transformTwCallsInModule({
        source,
        filename: cleanId,
        sourceType: extension === '.jsx' ? 'jsx' : extension === '.tsx' ? 'tsx' : ['.js', '.mjs', '.cjs'].includes(extension) ? 'javascript' : 'typescript',
        blockStart: { line: 1, column: 1 },
        additionalImports: imports,
      });
      assertCoveredMacroTransform({ changed: result.changed });
      return result.changed ? { code: result.code, map: result.map } : null;
    },
    hotUpdate: {
      order: 'pre',
      async handler(options) {
        if (cssPlanning === 'disabled') return options.modules;
        const absoluteFile = path.resolve(options.file);
        if (!isPathInside({ directory: absoluteSourceRoot, candidate: absoluteFile }) && absoluteFile !== absoluteTailwindCssPath) return options.modules;
        const refreshKey = `${options.timestamp}\0${absoluteFile}\0${fileContentFingerprint({ filename: absoluteFile })}`;
        const result = await scheduleRefresh({ key: refreshKey });
        if (this.environment.name !== environmentName) return options.modules;
        if (result.baseCssChanged) {
          const modules = this.environment.moduleGraph.getModulesByFile(absoluteTailwindCssPath);
          if (modules !== undefined) {
            for (const module of modules) await this.environment.reloadModule(module);
          }
        }
        for (const resolvedId of result.changedCssIds) {
          const module = this.environment.moduleGraph.getModuleById(resolvedId);
          if (module !== undefined) await this.environment.reloadModule(module);
        }
        for (const filename of result.changedOwnerModules) {
          const modules = this.environment.moduleGraph.getModulesByFile(filename);
          if (modules === undefined) continue;
          for (const module of modules) await this.environment.reloadModule(module);
        }
        if (result.removedCssIds.size > 0) {
          this.environment.hot.send?.({
            type: 'custom',
            event: 'naidan-tailwind:retire-css',
            data: { moduleIds: [...result.removedCssIds] },
          });
        }
        return options.modules;
      },
    },
    api: {
      getAnalysis: () => analysis,
      getPlan: () => plan,
      getImportsByModule: () => importsByModule,
      getOwnerRootByName: () => ownerRootByName,
    },
  };
}
