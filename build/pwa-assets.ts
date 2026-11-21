import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { parseSync, type Plugin, type ResolveModulePreloadDependenciesFn, type Rollup } from 'vite';
import type { ManifestTransform } from 'workbox-build';
import { isDeepStrictEqual } from 'node:util';
import { NodeTypes, parse, type ElementNode, type RootNode } from '@vue/compiler-dom';
import type { LlamaCppProfile } from '../src/features/llama-cpp-browser/types.ts';
import { chatProfileSchema } from '../src/features/llama-cpp-browser/chat-profiles.ts';
import { HOSTED_TRANSFORMERS_RUNTIME_ASSET_MANIFEST } from '../src/features/transformers-js/runtime/runtime-asset-manifest.ts';
import type { DeferredAssetGroup, DeferredAssetMetadata } from '../src/logic/pwa/asset-cache-protocol.ts';
import {
  matchesPermanentCacheExclusion, permanentCacheExclusions, pwaCachePolicy, type PWACacheRule, type PWARuntimeEngine,
} from '../src/logic/pwa/cache-policy.ts';
import type { BoundaryLocaleAssets } from './boundary-strings/locale-assets.ts';

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

function* htmlElements({ node }: { node: RootNode | ElementNode }): Iterable<ElementNode> {
  for (const child of node.children) {
    if (child.type === NodeTypes.ELEMENT) {
      yield child;
      if (child.tag.toLowerCase() !== 'template') {
        yield* htmlElements({ node: child });
      }
    }
  }
}

function htmlAttribute({ element, name }: { element: ElementNode; name: string }): string | undefined {
  for (const prop of element.props) {
    if (prop.type === NodeTypes.ATTRIBUTE && prop.name.toLowerCase() === name) {
      return prop.value?.content;
    }
  }
  return undefined;
}

function assertNoEagerLocaleAssets({ node, localeAssets, documentUrl, scope }: {
  node: RootNode;
  localeAssets: BoundaryLocaleAssets;
  documentUrl: URL;
  scope: URL;
}): void {
  const elements = [...htmlElements({ node })];
  const base = elements.find(element => element.tag.toLowerCase() === 'base' && htmlAttribute({ element, name: 'href' }) !== undefined);
  const resolution = base === undefined ? documentUrl : new URL(htmlAttribute({ element: base, name: 'href' }) ?? '', documentUrl);
  for (const element of elements) {
    const tag = element.tag.toLowerCase();
    const rel = htmlAttribute({ element, name: 'rel' })?.toLowerCase().split(/\s+/) ?? [];
    const href = tag === 'script' ? htmlAttribute({ element, name: 'src' })
      : tag === 'link' && (rel.includes('modulepreload') || (rel.includes('preload')
        && htmlAttribute({ element, name: 'as' })?.toLowerCase() === 'script'))
        ? htmlAttribute({ element, name: 'href' }) : undefined;
    if (href !== undefined) {
      const url = new URL(href, resolution);
      if (url.origin === scope.origin && url.pathname.startsWith(scope.pathname)
        && localeAssets.has(decodeURIComponent(url.pathname.slice(scope.pathname.length)))) {
        throw new Error(`HTML eagerly loads a Boundary Strings locale asset: ${documentUrl.pathname} -> ${href}`);
      }
    }
  }
}

export function createPWAAssets({ maximumAssetSize, getRuntimeArtifacts, getLocaleAssets }: {
  maximumAssetSize: number;
  getRuntimeArtifacts: () => PWARuntimeArtifacts;
  getLocaleAssets: () => BoundaryLocaleAssets | undefined;
}) {
  let outDir = '';
  let scopes = [new URL('https://naidan.invalid/')];
  let finalManifest: Map<string, ManifestAsset> | undefined;
  const preloads: {
    target: string;
    host: Parameters<ResolveModulePreloadDependenciesFn>[2];
    dependencies: readonly string[];
  }[] = [];
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
    const localesByFile = getLocaleAssets();
    if (localesByFile === undefined) {
      throw new Error('Missing Boundary Strings locale assets for the Hosted PWA build');
    }
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
    config(config) {
      const preload = config.build?.modulePreload;
      if (preload === false) {
        return;
      }
      const options = typeof preload === 'object' ? preload : {};
      const resolveDependencies: ResolveModulePreloadDependenciesFn = (filename, deps, context) => {
        const dependencies = options.resolveDependencies?.(filename, deps, context) ?? deps;
        if (dependencies.length > 0) {
          preloads.push({ target: filename, host: context, dependencies: [...dependencies] });
        }
        return dependencies;
      };
      return { build: { modulePreload: { ...options, resolveDependencies } } };
    },
    configResolved(config) {
      outDir = path.resolve(config.root, config.build.outDir);
      scopes = config.base.startsWith('/') ? [new URL(config.base, 'https://naidan.invalid')]
        : [new URL('https://naidan.invalid/'), new URL('https://naidan.invalid/app/')];
    },
    buildStart() {
      finalManifest = undefined;
      llamaScripts.clear();
      preloads.length = 0;
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
        const localeAssets = getLocaleAssets();
        if (localeAssets === undefined) {
          throw new Error('Missing Boundary Strings locale assets for the Hosted PWA audit');
        }
        const checkedLocales = new Set<string>();
        const seen = new Set<string>();
        for (const entry of entries) {
          const locale = localeAssets.get(entry.url);
          if (locale !== undefined) {
            if (entry.deferred?.group.kind !== 'locale' || entry.deferred.group.locale !== locale) {
              throw new Error(`Incorrect Boundary Strings locale ownership in Worker: ${entry.url} (${locale})`);
            }
            checkedLocales.add(entry.url);
          }
          const asset = expected.get(entry.url);
          if (asset === undefined || asset.revision !== entry.revision || asset.integrity !== entry.integrity
            || !isDeepStrictEqual(asset.deferred, entry.deferred)) {
            throw new Error(`Unexpected Hosted PWA manifest entry: ${entry.url}`);
          }
          seen.add(entry.url);
        }
        for (const file of localeAssets.keys()) {
          if (!checkedLocales.has(file)) {
            throw new Error(`Missing Boundary Strings locale asset in Worker: ${file}`);
          }
        }
        const applicationFiles = await listApplicationAssets();
        if (localeAssets.size > 0) {
          for (const { target, host, dependencies } of preloads) {
            const owner = (() => {
              switch (host.hostType) {
              case 'html': return undefined;
              case 'js': return localeAssets.get(target);
              default: {
                const exhaustive: never = host.hostType;
                throw new Error(String(exhaustive));
              }
              }
            })();
            for (const dependency of dependencies) {
              const locale = localeAssets.get(dependency);
              if (locale !== undefined && locale !== owner) {
                throw new Error(`Vite preloads a Boundary Strings locale asset outside its language: ${host.hostId} -> ${target} -> ${dependency}`);
              }
            }
          }
          for (const file of applicationFiles.filter(file => file.endsWith('.html'))) {
            const node = parse(await readFile(path.join(outDir, file), 'utf8'));
            for (const scope of scopes) {
              assertNoEagerLocaleAssets({ node, localeAssets, documentUrl: new URL(file, scope), scope });
            }
          }
        }
        const missing = [...new Set([...expected.keys(), ...applicationFiles])].filter(file => !seen.has(file));
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
