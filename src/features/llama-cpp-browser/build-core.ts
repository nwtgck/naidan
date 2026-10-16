import { createHash } from 'node:crypto';
import path from 'node:path';
import { normalizePath, type Plugin } from 'vite';
import { profileSchema, type LlamaCppProfile } from './types';
import { readLlamaArtifactPackage } from './build-artifact-package';
// eslint-disable-next-line local-rules-imports/prefer-root-alias-imports -- This build entry is also checked by tsconfig.node.json, which has no @ alias.
import type { StandaloneEmbeddedBinary } from '../file-protocol-standalone/build-types';

// Standalone selects either embedded JSPI artifact through Worker capability checks.
const standaloneProfiles = ['webgpu-wasm64-jspi', 'webgpu-wasm32-jspi'] as const;
const virtualPrefix = 'virtual:llama-cpp-browser-core/';
const standaloneBinaryIds = {
  'webgpu-wasm64-jspi': 'virtual:file-protocol-standalone/binary/llama-cpp-browser',
  'webgpu-wasm32-jspi': 'virtual:file-protocol-standalone/binary/llama-cpp-browser-wasm32-jspi',
} as const;

/** Preserve complete legal comment blocks instead of redistributing megabytes of
 * unrelated C/C++ header implementation just to include their embedded notices. */
function embeddedNotices({ source }: { source: string }): string {
  const comments = source.match(/\/\*[\s\S]*?\*\/|(?:^[ \t]*\/\/[^\n]*(?:\n|$))+/gm) ?? [];
  const notices = comments.filter(comment => /copyright|licen[cs]e|public domain|permission is hereby|redistribution/i.test(comment));
  if (notices.length === 0) {
    throw new Error('Missing embedded native license notices');
  }
  return notices.join('\n\n');
}

export function createLlamaCppBrowserBuild({ rootDir, mode }: { rootDir: string, mode: 'hosted' | 'standalone' }): {
  corePlugin: Plugin;
  embeddedBinaries: readonly StandaloneEmbeddedBinary[];
} {
  const { packageRoot, profileRoot: artifactProfiles, manifestPaths, files, readArtifact } = readLlamaArtifactPackage({ rootDir });
  const isStandalone = (() => {
    switch (mode) {
    case 'standalone': return true;
    case 'hosted': return false;
    default: {
      const exhaustive: never = mode;
      throw new Error(`Unhandled build mode: ${exhaustive}`);
    }
    }
  })();
  const profiles: readonly LlamaCppProfile[] = isStandalone ? standaloneProfiles : profileSchema.options;
  const cores = profiles.map(profile => {
    // Verify at plugin creation too: an optimizer cache must not hide corrupt input.
    const core = readArtifact({ relative: `profiles/${profile}/browser/core.mjs` });
    return { profile, core };
  });
  const embeddedBinaries = isStandalone ? standaloneProfiles.map(profile => {
    const wasm = readArtifact({ relative: `profiles/${profile}/browser/core.wasm` });
    return { virtualId: standaloneBinaryIds[profile], filePath: wasm.filePath, bytes: wasm.bytes, sha256: wasm.sha256 };
  }) : [];
  const profileRoot = normalizePath(artifactProfiles) + '/';
  const byId = new Map(cores.map(entry => [normalizePath(entry.core.filePath), entry]));
  const byVirtualId = new Map(cores.map(entry => [virtualPrefix + entry.profile, normalizePath(entry.core.filePath)]));
  const identity = createHash('sha256').update(cores.map(entry => entry.core.sha256).join('\0')).digest('hex');

  const licenseFiles = [...files.keys()].filter(relative => relative === 'LICENSE' || relative.startsWith('licenses/'));
  const licenseText = [
    'llama.cpp browser native notices',
    ...cores.map(entry => `Runtime profile: ${entry.profile}\ncore.mjs SHA-256: ${entry.core.sha256}`),
    ...embeddedBinaries.map(wasm => `${wasm.virtualId} core.wasm SHA-256: ${wasm.sha256}`),
    ...licenseFiles.map(relative => {
      const source = readArtifact({ relative }).data.toString('utf8');
      const text = relative.startsWith('licenses/embedded/') ? embeddedNotices({ source }) : source;
      return `===== ${relative} =====\n${text}`;
    }),
  ].join('\n\n');

  return {
    embeddedBinaries,
    corePlugin: {
      name: `naidan-llama-cpp-browser-core-${identity}`,
      enforce: 'pre',
      config() {
        // Keep the source behind this loader in dev as well as production.
        return { optimizeDeps: { exclude: ['llama-cpp-browser-core', ...profileSchema.options.map(profile => virtualPrefix + profile)] } };
      },
      resolveId(id) {
        if (!id.startsWith(virtualPrefix)) {
          return;
        }
        const resolved = byVirtualId.get(id);
        if (!resolved) {
          throw new Error(`Unavailable llama.cpp core import: ${id}`);
        }
        // The real package path keeps license collection and module provenance intact.
        return resolved;
      },
      generateBundle() {
        this.emitFile({ type: 'asset', fileName: 'llama-cpp-browser-native-licenses.txt', source: licenseText });
      },
      load(id) {
        const filePath = normalizePath(id.split('?')[0]!);
        if (!filePath.startsWith(profileRoot)) {
          return;
        }
        // Reject other native modules before tree shaking can hide their provenance.
        const entry = byId.get(filePath);
        if (!entry) {
          throw new Error(`Unavailable llama.cpp artifact: ${filePath}`);
        }
        for (const manifestPath of manifestPaths) {
          this.addWatchFile(manifestPath);
        }
        this.addWatchFile(entry.core.filePath);
        for (const relative of licenseFiles) {
          this.addWatchFile(path.join(packageRoot, 'llama-cpp-browser-core', relative));
        }
        return readArtifact({ relative: `profiles/${entry.profile}/browser/core.mjs` }).data.toString('utf8');
      },
    },
  };
}

export const TEST_ONLY = {
  embeddedNotices,
};
