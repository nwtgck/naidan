import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { parseSync, type Plugin, type Rollup } from 'vite';
import type { ManifestTransform } from 'workbox-build';
import { isDeepStrictEqual } from 'node:util';
import type { UiLocale } from '../src/01-models/ui-locale.ts';
import type { LlamaCppProfile } from '../src/features/llama-cpp-browser/types.ts';
import { chatProfileSchema } from '../src/features/llama-cpp-browser/chat-profiles.ts';
import { HOSTED_TRANSFORMERS_RUNTIME_ASSET_MANIFEST } from '../src/features/transformers-js/runtime/runtime-asset-manifest.ts';
import type { DeferredAssetGroup, DeferredAssetMetadata } from '../src/logic/pwa/asset-cache-protocol.ts';
import {
  matchesPermanentCacheExclusion, permanentCacheExclusions, pwaCachePolicy, type PWACacheRule, type PWARuntimeEngine,
} from '../src/logic/pwa/cache-policy.ts';
import { createBoundaryStringProjectPaths } from './boundary-strings/message-catalog.ts';
import { parseLocaleMessageModuleId } from './boundary-strings/module-id.ts';
import { parseResolvedBoundaryModuleId, parseResolvedPackModuleId } from './boundary-strings/virtual-modules.ts';

function isOutputChunk(item: Rollup.OutputAsset | Rollup.OutputChunk): item is Rollup.OutputChunk {
  switch (item.type) {
  case 'asset': return false;
  case 'chunk': return true;
  default: {
    const exhaustive: never = item;
    throw new Error(String(exhaustive));
  }
  }
}

type RuntimeArtifact = { profile: string; modulePath: string; wasmPath: string };
export type PWARuntimeArtifacts = Partial<Record<PWARuntimeEngine, readonly RuntimeArtifact[]>>;
type ManifestAsset = { url: string; revision: string | null; integrity?: string; deferred?: DeferredAssetMetadata };
type RuntimeAsset = Extract<DeferredAssetGroup, { kind: 'runtime' }>;

function findInjectedManifest({ node }: { node: unknown }): { start: number; end: number } | undefined {
  if (node === null || typeof node !== 'object') {
    return undefined;
  }
  if ('type' in node && node.type === 'Property' && 'key' in node && node.key !== null && typeof node.key === 'object'
    && (('name' in node.key && node.key.name === '__naidanPrecache') || ('value' in node.key && node.key.value === '__naidanPrecache'))
    && 'value' in node && node.value !== null && typeof node.value === 'object'
    && 'type' in node.value && node.value.type === 'ArrayExpression'
    && 'start' in node.value && typeof node.value.start === 'number' && 'end' in node.value && typeof node.value.end === 'number') {
    return { start: node.value.start, end: node.value.end };
  }
  for (const child of Object.values(node)) {
    const range = findInjectedManifest({ node: child });
    if (range !== undefined) {
      return range;
    }
  }
  return undefined;
}

export function createPWAAssets({ maximumAssetSize, getRuntimeArtifacts }: {
  maximumAssetSize: number;
  getRuntimeArtifacts: () => PWARuntimeArtifacts;
}) {
  let outDir = '';
  let messagesDirectoryPath = '';
  let finalManifest: Map<string, ManifestAsset> | undefined;
  const localesByFile = new Map<string, UiLocale>();
  const builtInRuntimeFiles = new Map<string, RuntimeAsset>();
  const llamaScripts = new Map<string, RuntimeAsset | undefined>();
  for (const profile of chatProfileSchema.options) {
    builtInRuntimeFiles.set(`llama-cpp-browser-runtime/profiles/${profile}/core.wasm.gz`, { kind: 'runtime', engine: 'llama-cpp-browser', profile });
  }
  for (const { variant, mjs, wasm } of HOSTED_TRANSFORMERS_RUNTIME_ASSET_MANIFEST.variants) {
    const asset = { kind: 'runtime', engine: 'transformers-js', profile: variant } as const;
    builtInRuntimeFiles.set(`transformers/${mjs.publicFileName}`, asset);
    builtInRuntimeFiles.set(`transformers/${wasm.physicalFileName}`, asset);
  }

  async function listApplicationAssets(): Promise<string[]> {
    const entries = await readdir(outDir, { recursive: true, withFileTypes: true });
    return entries.filter(entry => entry.isFile()).map(entry =>
      path.relative(outDir, path.join(entry.parentPath, entry.name)).split(path.sep).join('/'),
    ).filter(file => file !== 'sw.js' && file !== 'manifest.webmanifest'
      && !permanentCacheExclusions.some(rule => matchesPermanentCacheExclusion({ file, rule })));
  }

  const transform: ManifestTransform = async manifest => {
    const runtimeFiles = new Map(builtInRuntimeFiles);
    const ambiguousRuntimeFiles = new Set<string>();
    const runtimeArtifacts = getRuntimeArtifacts();
    for (const engine of Object.keys(runtimeArtifacts) as PWARuntimeEngine[]) {
      for (const artifact of runtimeArtifacts[engine] ?? []) {
        const asset = { kind: 'runtime', engine, profile: artifact.profile } as const;
        for (const file of [artifact.modulePath, artifact.wasmPath]) {
          const previous = runtimeFiles.get(file);
          if (previous !== undefined && !isDeepStrictEqual(previous, asset)) {
            ambiguousRuntimeFiles.add(file);
          }
          runtimeFiles.set(file, asset);
        }
      }
    }
    const rules: readonly PWACacheRule[] = pwaCachePolicy.rules;
    const entriesByFile = new Map(manifest.filter(entry => !permanentCacheExclusions
      .some(rule => matchesPermanentCacheExclusion({ file: entry.url, rule }))).map(entry => [entry.url, entry]));
    for (const file of await listApplicationAssets()) {
      const locale = localesByFile.get(file);
      const runtime = ambiguousRuntimeFiles.has(file) ? undefined : runtimeFiles.get(file) ?? llamaScripts.get(file);
      const groups: DeferredAssetGroup[] = [];
      for (const rule of rules) {
        if (rule.cache === 'manual' && rule.match.path === file) {
          groups.push({ kind: 'manual' });
        }
        if (rule.precacheFor === 'app-locales' && locale !== undefined) {
          groups.push({ kind: 'locale', locale });
        }
        if (rule.precacheFor === 'auto-selected-runtime' && runtime?.engine === rule.match.dedicatedTo) {
          groups.push(runtime);
        }
      }
      if (groups.length > 1) {
        throw new Error(`Multiple PWA cache rules match ${file}`);
      }
      const disposition = groups.at(0) ?? pwaCachePolicy.default;
      const group = disposition === 'precache' ? undefined : disposition;
      const existing = entriesByFile.get(file);
      if (group === undefined && existing !== undefined) {
        continue;
      }

      const contents = await readFile(path.join(outDir, file));
      if (contents.byteLength > maximumAssetSize) {
        throw new Error(`Hosted PWA asset exceeds its cache size limit: ${file}`);
      }
      const hash = createHash('sha256').update(contents).digest('base64');
      const metadata: DeferredAssetMetadata | undefined = group === undefined ? undefined : {
        group,
        integrity: `sha256-${hash}`,
      };
      entriesByFile.set(file, {
        url: file,
        revision: existing?.revision ?? hash,
        size: contents.byteLength,
        ...{ deferred: metadata },
      });
    }
    finalManifest = entriesByFile;
    return { manifest: [...entriesByFile.values()], warnings: [] };
  };

  const plugin: Plugin = {
    name: 'naidan-pwa-assets',
    apply: 'build',
    configResolved(config) {
      outDir = path.resolve(config.root, config.build.outDir);
      messagesDirectoryPath = createBoundaryStringProjectPaths({ root: config.root }).messagesDirectoryPath;
    },
    buildStart() {
      finalManifest = undefined;
      llamaScripts.clear();
    },
    generateBundle: {
      order: 'post',
      handler(_options, bundle) {
        localesByFile.clear();
        const chunks = Object.values(bundle).filter(isOutputChunk);
        const candidates = new Map<string, UiLocale>();
        const packChunks = new Set<string>();
        const directlyImportedPacks = new Set<string>();
        // Rolldown can split messages shared by several packs into their own chunks.
        for (const item of chunks) {
          const owners = new Set(item.moduleIds.map(id => {
            const pack = parseResolvedPackModuleId({ id });
            if (pack !== undefined) {
              packChunks.add(item.fileName);
              const importers = this.getModuleInfo(id)?.dynamicImporters;
              if (!importers?.length || importers.some(importer => {
                const boundary = parseResolvedBoundaryModuleId({ id: importer });
                return boundary?.boundaryId !== pack.boundaryId || boundary.version !== pack.version;
              })) {
                directlyImportedPacks.add(item.fileName);
              }
              return pack.locale;
            }
            if (id.includes('?')) {
              return undefined;
            }
            return parseLocaleMessageModuleId({ moduleId: id, messagesDirectoryPath })?.locale;
          }));
          const locale = owners.values().next().value;
          if (owners.size === 1 && locale !== undefined) {
            candidates.set(item.fileName, locale);
          }
        }

        const entryDependencies = chunks.filter(item => item.isEntry).map(item => item.fileName);
        const startup = new Set<string>();
        const required = new Set<string>();
        while (entryDependencies.length > 0) {
          const file = entryDependencies.pop();
          if (file === undefined || startup.has(file)) {
            continue;
          }
          startup.add(file);
          const item = bundle[file];
          if (item && isOutputChunk(item)) {
            entryDependencies.push(...item.imports);
            // Settings, initialization and recovery can read a bootstrap locale before settings load.
            for (const imported of item.dynamicImports) {
              required.add(imported);
            }
          }
        }
        for (const item of chunks) {
          const locale = candidates.get(item.fileName);
          if (locale === undefined || startup.has(item.fileName) || directlyImportedPacks.has(item.fileName)) {
            required.add(item.fileName);
          }
          for (const imported of item.imports) {
            if (candidates.get(imported) !== locale) {
              required.add(imported);
            }
          }
          for (const imported of item.dynamicImports) {
            // The generated locale loaders target packs. Direct imports of
            // message modules have no such selection contract.
            if (candidates.has(imported) && !packChunks.has(imported)) {
              required.add(imported);
            }
          }
        }
        // Unconditional chunks also need their entire static dependency graph.
        for (const file of required) {
          const item = bundle[file];
          if (item && isOutputChunk(item)) {
            for (const imported of item.imports) {
              required.add(imported);
            }
          }
        }
        for (const [file, locale] of candidates) {
          if (!required.has(file)) {
            localesByFile.set(file, locale);
          }
        }
      },
    },
    closeBundle: {
      order: 'post',
      sequential: true,
      async handler(error) {
        if (error || finalManifest === undefined) {
          return;
        }
        const expected = new Map(finalManifest);
        const manifestFile = 'manifest.webmanifest';
        const webmanifest = await readFile(path.join(outDir, manifestFile));
        expected.set(manifestFile, { url: manifestFile, revision: createHash('md5').update(webmanifest).digest('hex') });
        const source = await readFile(path.join(outDir, 'sw.js'), 'utf8');
        const range = findInjectedManifest({ node: parseSync('sw.js', source).program });
        if (range === undefined) {
          throw new Error('Missing final Hosted PWA manifest');
        }
        const entries: ManifestAsset[] = JSON.parse(source.slice(range.start, range.end));
        const seen = new Set<string>();
        for (const entry of entries) {
          const asset = expected.get(entry.url);
          if (asset === undefined || asset.revision !== entry.revision || asset.integrity !== entry.integrity
            || !isDeepStrictEqual(asset.deferred, entry.deferred)) {
            throw new Error(`Unexpected Hosted PWA manifest entry: ${entry.url}`);
          }
          seen.add(entry.url);
        }
        const missing = [...new Set([...expected.keys(), ...await listApplicationAssets()])].filter(file => !seen.has(file));
        if (missing.length > 0) {
          throw new Error(`Hosted PWA manifest is missing assets: ${missing.join(', ')}`);
        }
      },
    },
  };

  function workerPlugin({ profileForModule }: { profileForModule: ({ id }: { id: string }) => LlamaCppProfile | undefined }): Plugin {
    return {
      name: 'naidan-pwa-llama-assets',
      generateBundle: {
        order: 'post',
        handler(_options, bundle) {
          const chunks = Object.values(bundle).filter(isOutputChunk);
          const staticallyImported = new Set(chunks.flatMap(item => item.imports));
          for (const item of chunks) {
            const profiles = new Set(item.moduleIds.map(id => profileForModule({ id })));
            const profile = chatProfileSchema.safeParse(profiles.values().next().value);
            const group = !item.isEntry && !staticallyImported.has(item.fileName) && profiles.size === 1 && profile.success
              ? { kind: 'runtime' as const, engine: 'llama-cpp-browser' as const, profile: profile.data } : undefined;
            // One filename may be shared by more than one worker build.
            const previous = llamaScripts.get(item.fileName);
            if (!llamaScripts.has(item.fileName) || group?.profile === previous?.profile) {
              llamaScripts.set(item.fileName, group);
            } else {
              llamaScripts.set(item.fileName, undefined);
            }
          }
        },
      },
    };
  }

  return { plugin, transform, workerPlugin };
}

export const TEST_ONLY = {
};
