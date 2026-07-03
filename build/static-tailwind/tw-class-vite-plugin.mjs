import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  transformTwCallsInModule,
  transformTwCallsInVueSource,
} from './tw-class-core.mjs';
import {
  analyzeSourceModules,
  serializeSourceAnalysis,
} from './source-module-analyzer.mjs';
import {
  createCssOwnershipPlan,
  serializeCssOwnershipPlan,
  writeCssOwnershipDebugFiles,
} from './css-ownership-planner.mjs';

const virtualMacroModuleId = 'virtual:naidan-tailwind';
const resolvedVirtualMacroModuleId = '\0virtual:naidan-tailwind';
const virtualCssPrefix = 'virtual:naidan-tailwind-css/';
const virtualHmrClientModuleId = 'virtual:naidan-tailwind-hmr-client';
const resolvedVirtualHmrClientModuleId = '\0virtual:naidan-tailwind-hmr-client';
const supportedModuleExtensions = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']);

function readExpectedTailwindVersion({ projectRoot }) {
  const packageJson = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
  const version = packageJson.devDependencies?.tailwindcss ?? packageJson.dependencies?.tailwindcss;
  if (version === undefined || !/^\d+\.\d+\.\d+$/u.test(version)) {
    throw new Error('[tw-class] tailwindcss must be pinned to an exact version in package.json.');
  }
  return version;
}

function groupHash({ ownerKey }) {
  return crypto.createHash('sha256').update(ownerKey).digest('hex').slice(0, 16);
}

function normalizeAliases({ aliases, projectRoot }) {
  return aliases.map(({ find, replacement }) => ({
    find: String(find),
    replacement: path.isAbsolute(replacement) ? replacement : path.resolve(projectRoot, replacement),
  }));
}

function ownerNamesFromKey({ key }) {
  return key === '' ? [] : key.split('|');
}

export function createTwClassVitePlugin({
  projectRoot,
  sourceRoot,
  entryModule,
  tailwindCssPath,
  aliases,
  additionalLazyRootDirectories,
  debugOutputDirectory,
  splitCss,
  cssPlanning,
  maxLazyCssGroups,
}) {
  const absoluteProjectRoot = path.resolve(projectRoot);
  const absoluteSourceRoot = path.resolve(sourceRoot);
  const absoluteEntryModule = path.resolve(entryModule);
  const absoluteTailwindCssPath = path.resolve(tailwindCssPath);
  const absoluteDebugOutputDirectory = debugOutputDirectory === undefined
    ? undefined
    : path.resolve(debugOutputDirectory);
  const expectedTailwindVersion = readExpectedTailwindVersion({ projectRoot: absoluteProjectRoot });
  const resolvedAliases = normalizeAliases({ aliases, projectRoot: absoluteProjectRoot });
  let command = 'build';
  let environmentName = 'client';
  let analysis;
  let plan;
  let baselineCss = '';
  let cssByResolvedId = new Map();
  let importsByModule = new Map();
  let ownerRootByName = new Map();
  const retiredCssIds = new Set();
  let lastRefreshTimestamp;
  let lastRefreshPromise;

  function buildVirtualState({ nextAnalysis, nextPlan }) {
    if (!splitCss) {
      return {
        nextCssByResolvedId: new Map(),
        nextImportsByModule: new Map(),
        nextOwnerRootByName: new Map([['initial', absoluteEntryModule]]),
      };
    }
    const nextCssByResolvedId = new Map();
    const nextImportsByModule = new Map();
    const nextOwnerRootByName = new Map([['initial', absoluteEntryModule]]);
    for (const owner of nextAnalysis.lazyOwners) nextOwnerRootByName.set(owner.name, owner.root);

    for (const [ownerKey, css] of nextPlan.cssGroups) {
      if (css.trim() === '') continue;
      const normalizedOwners = ownerNamesFromKey({ key: ownerKey });
      const owners = normalizedOwners.length === 0 ? ['initial'] : normalizedOwners;
      const publicId = `${virtualCssPrefix}${groupHash({ ownerKey: owners.join('|') })}.css`;
      const resolvedId = `\0${publicId}`;
      nextCssByResolvedId.set(resolvedId, css);
      for (const owner of owners) {
        const root = nextOwnerRootByName.get(owner);
        if (root === undefined) throw new Error(`[tw-class] CSS owner has no module root: ${owner}`);
        const values = nextImportsByModule.get(root) ?? new Set();
        values.add(publicId);
        nextImportsByModule.set(root, values);
      }
    }
    if (command === 'serve') {
      const entryImports = nextImportsByModule.get(absoluteEntryModule) ?? new Set();
      entryImports.add(virtualHmrClientModuleId);
      nextImportsByModule.set(absoluteEntryModule, entryImports);
    }
    return {
      nextCssByResolvedId,
      nextImportsByModule: new Map([...nextImportsByModule].map(([file, values]) => [file, [...values].sort()])),
      nextOwnerRootByName,
    };
  }

  async function refreshPlan() {
    const nextAnalysis = analyzeSourceModules({
      projectRoot: absoluteProjectRoot,
      sourceRoot: absoluteSourceRoot,
      entryModule: absoluteEntryModule,
      aliases: resolvedAliases,
      additionalLazyRootDirectories,
    });
    if (splitCss && nextAnalysis.unresolvedDynamicImports.length > 0) {
      const details = nextAnalysis.unresolvedDynamicImports.map(({ filename, line, column, expression }) => (
        `${filename}:${line}:${column} import(${expression})`
      ));
      throw new Error(`[tw-class] Dynamic imports must use static string literals for safe CSS ownership:\n${details.join('\n')}`);
    }
    const nextPlan = await createCssOwnershipPlan({
      projectRoot: absoluteProjectRoot,
      cssEntryPath: absoluteTailwindCssPath,
      expectedTailwindVersion,
      analysis: nextAnalysis,
      maxLazyCssGroups,
    });
    const state = buildVirtualState({ nextAnalysis, nextPlan });
    const previousCssByResolvedId = cssByResolvedId;
    const previousImportsByModule = importsByModule;
    const previousBaselineCss = baselineCss;
    analysis = nextAnalysis;
    plan = nextPlan;
    baselineCss = splitCss ? nextPlan.baselineCss : nextPlan.globalCss;
    for (const id of previousCssByResolvedId.keys()) {
      if (!state.nextCssByResolvedId.has(id)) retiredCssIds.add(id);
    }
    for (const id of state.nextCssByResolvedId.keys()) retiredCssIds.delete(id);
    cssByResolvedId = state.nextCssByResolvedId;
    importsByModule = state.nextImportsByModule;
    ownerRootByName = state.nextOwnerRootByName;

    const changedCssIds = new Set([...previousCssByResolvedId.keys(), ...cssByResolvedId.keys()].filter((id) => previousCssByResolvedId.get(id) !== cssByResolvedId.get(id)));
    const removedCssIds = new Set([...previousCssByResolvedId.keys()].filter((id) => !cssByResolvedId.has(id)));
    const changedOwnerModules = new Set([...previousImportsByModule.keys(), ...importsByModule.keys()].filter((id) => (
      JSON.stringify(previousImportsByModule.get(id) ?? []) !== JSON.stringify(importsByModule.get(id) ?? [])
    )));
    return {
      baseCssChanged: previousBaselineCss !== '' && previousBaselineCss !== baselineCss,
      changedCssIds,
      removedCssIds,
      changedOwnerModules,
    };
  }

  function writeDebugOutput() {
    if (absoluteDebugOutputDirectory === undefined || analysis === undefined || plan === undefined) return;
    fs.rmSync(absoluteDebugOutputDirectory, { recursive: true, force: true });
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
      await refreshPlan();
      this.info(splitCss
        ? `[tw-class] planned ${plan.candidates.length} candidates into ${plan.cssGroups.size} virtual CSS ownership groups.`
        : `[tw-class] planned ${plan.candidates.length} candidates into one global CSS asset.`);
    },
    writeBundle() {
      if (cssPlanning === 'enabled' && command === 'build') writeDebugOutput();
    },
    resolveId(id) {
      if (id === virtualMacroModuleId) return resolvedVirtualMacroModuleId;
      if (id === virtualHmrClientModuleId) return resolvedVirtualHmrClientModuleId;
      if (id.startsWith(virtualCssPrefix)) return `\0${id}`;
      return null;
    },
    load(id) {
      if (id === resolvedVirtualHmrClientModuleId) {
        return `if (import.meta.hot) { import.meta.hot.on('naidan-tailwind:retire-css', ({ ids }) => { for (const id of ids) { for (const element of document.querySelectorAll('style[data-vite-dev-id]')) { if (element.dataset.viteDevId === id) element.remove(); } } }); }`;
      }
      if (id === resolvedVirtualMacroModuleId) {
        return "const fail = () => { throw new Error('Tailwind compile-time macro was not transformed.'); }; export const tw = fail; export const twClassString = fail; export const twClasses = fail; export const customClasses = fail;";
      }
      if (cssByResolvedId.has(id)) return cssByResolvedId.get(id);
      if (retiredCssIds.has(id)) return '';
      const cleanId = id.split('?', 1)[0];
      if (path.resolve(cleanId) === absoluteTailwindCssPath) return baselineCss;
      return null;
    },
    transform(source, id) {
      const cleanId = id.split('?', 1)[0];
      if (cleanId.includes('/node_modules/')) return null;
      const imports = importsByModule.get(path.resolve(cleanId)) ?? [];
      if (cleanId.endsWith('.vue') && !id.includes('?')) {
        const result = transformTwCallsInVueSource({ source, filename: cleanId, additionalImports: imports });
        return result.changed ? { code: result.code, map: result.map } : null;
      }
      const extension = path.extname(cleanId);
      if (!supportedModuleExtensions.has(extension)) return null;
      const result = transformTwCallsInModule({
        source,
        filename: cleanId,
        sourceType: ['.js', '.jsx', '.mjs', '.cjs'].includes(extension) ? 'javascript' : 'typescript',
        blockStart: { line: 1, column: 1 },
        additionalImports: imports,
      });
      return result.changed ? { code: result.code, map: result.map } : null;
    },
    hotUpdate: {
      order: 'pre',
      async handler(options) {
        if (cssPlanning === 'disabled') return options.modules;
        if (!path.resolve(options.file).startsWith(absoluteSourceRoot) && path.resolve(options.file) !== absoluteTailwindCssPath) return options.modules;
        if (lastRefreshTimestamp !== options.timestamp) {
          lastRefreshTimestamp = options.timestamp;
          lastRefreshPromise = refreshPlan();
        }
        const result = await lastRefreshPromise;
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
            data: { ids: [...result.removedCssIds] },
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
