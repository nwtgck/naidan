import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import type { Plugin, Rollup } from 'vite';
import type { ManifestTransform } from 'workbox-build';
import { parseUiLocale, type UiLocale } from '../src/01-models/ui-locale.ts';
import type { LlamaCppProfile } from '../src/features/llama-cpp-browser/types.ts';
import { chatProfileSchema } from '../src/features/llama-cpp-browser/runtime/chat-profiles.ts';
import { HOSTED_TRANSFORMERS_RUNTIME_ASSET_MANIFEST } from '../src/features/transformers-js/runtime/runtime-asset-manifest.ts';
import type { DeferredAssetGroup, DeferredAssetMetadata } from '../src/logic/pwa/asset-cache-protocol.ts';
import { parseResolvedPackModuleId } from './boundary-strings/virtual-modules.ts';

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

export function createPWAAssets({ maximumAssetSize }: { maximumAssetSize: number }) {
  let outDir = '';
  let projectRoot = '';
  let finalManifest: Set<string> | undefined;
  const localesByFile = new Map<string, UiLocale>();
  const transformersByFile = new Map<string, DeferredAssetGroup>();
  const llamaByFile = new Map<string, DeferredAssetGroup>();
  const llamaScripts = new Map<string, DeferredAssetGroup | undefined>();
  for (const profile of chatProfileSchema.options) {
    llamaByFile.set(`llama-cpp-browser-runtime/profiles/${profile}/core.wasm.gz`, { kind: 'llama', profile });
  }
  for (const { variant, mjs, wasm } of HOSTED_TRANSFORMERS_RUNTIME_ASSET_MANIFEST.variants) {
    transformersByFile.set(`transformers/${mjs.publicFileName}`, { kind: 'transformers', variant });
    transformersByFile.set(`transformers/${wasm.physicalFileName}`, { kind: 'transformers', variant });
  }

  async function listApplicationAssets(): Promise<string[]> {
    const entries = await readdir(outDir, { recursive: true, withFileTypes: true });
    return entries.filter(entry => entry.isFile()).map(entry =>
      path.relative(outDir, path.join(entry.parentPath, entry.name)).split(path.sep).join('/'),
    ).filter(file => file !== 'sw.js' && file !== 'manifest.webmanifest'
      && !file.endsWith('.map') && !/^naidan-standalone-.*\.zip$/.test(path.posix.basename(file)));
  }

  const transform: ManifestTransform = async manifest => {
    const entriesByFile = new Map(manifest.map(entry => [entry.url, entry]));
    for (const file of await listApplicationAssets()) {
      const locale = localesByFile.get(file);
      const group: DeferredAssetGroup | undefined = file === 'naidan-standalone.zip' ? { kind: 'standalone-package' }
        : locale === undefined ? transformersByFile.get(file) ?? llamaByFile.get(file) ?? llamaScripts.get(file)
          : { kind: 'locale', locale };
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
    finalManifest = new Set(entriesByFile.keys());
    return { manifest: [...entriesByFile.values()], warnings: [] };
  };

  const plugin: Plugin = {
    name: 'naidan-pwa-assets',
    apply: 'build',
    configResolved(config) {
      outDir = path.resolve(config.root, config.build.outDir);
      projectRoot = config.root.replaceAll('\\', '/');
    },
    buildStart() {
      finalManifest = undefined;
      llamaScripts.clear();
    },
    generateBundle: {
      order: 'post',
      handler(_options, bundle) {
        localesByFile.clear();
        const staticallyImported = new Set<string>();
        const chunks = Object.values(bundle).filter(isOutputChunk);
        const entryDependencies = chunks.filter(item => item.isEntry).map(item => item.fileName);
        const startup = new Set<string>();
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
              staticallyImported.add(imported);
            }
          }
        }
        for (const item of chunks) {
          for (const imported of item.imports) {
            staticallyImported.add(imported);
          }
        }
        for (const item of chunks) {
          if (startup.has(item.fileName) || staticallyImported.has(item.fileName)) {
            continue;
          }
          let locale: UiLocale | undefined;
          let hasPack = false;
          const messageRoot = `${projectRoot}/src/strings/messages/`;
          for (const id of item.moduleIds) {
            const pack = parseResolvedPackModuleId({ id });
            hasPack ||= pack !== undefined;
            const messagePath = id.replaceAll('\\', '/');
            const messageLocale = messagePath.startsWith(messageRoot)
              ? /^[^/]+\/([^/]+)\.ts$/.exec(messagePath.slice(messageRoot.length))?.[1] : undefined;
            const owner = parseUiLocale({ value: pack?.locale ?? messageLocale ?? '' });
            if (owner === undefined || (locale !== undefined && locale !== owner)) {
              locale = undefined;
              break;
            }
            locale = owner;
          }
          if (hasPack && locale !== undefined) {
            localesByFile.set(item.fileName, locale);
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
        const missing = (await listApplicationAssets()).filter(file => !finalManifest?.has(file));
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
              ? { kind: 'llama' as const, profile: profile.data } : undefined;
            // One filename may be shared by more than one worker build.
            const previous = llamaScripts.get(item.fileName);
            if (!llamaScripts.has(item.fileName) || (previous?.kind === 'llama' && group?.profile === previous.profile)) {
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
