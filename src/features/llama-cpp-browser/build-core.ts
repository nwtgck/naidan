import { createHash } from 'node:crypto';
import path from 'node:path';
// eslint-disable-next-line local-rules-imports/prefer-root-alias-imports -- Build entry is also checked without the app alias.
import type { NativeLicenseSource } from '../../01-models/native-license-build-source';
import { normalizePath, type Plugin } from 'vite';
import { gpuProfilingProfile, profileSchema, type LlamaCppProfile } from './types';
import { hostedArtifactProfiles, readLlamaArtifactPackage } from './build-artifact-package';
// eslint-disable-next-line local-rules-imports/prefer-root-alias-imports -- This build entry is also checked by tsconfig.node.json, which has no @ alias.
import type { StandaloneEmbeddedBinary } from '../file-protocol-standalone/build-types';

// Standalone selects either embedded JSPI artifact through Worker capability checks.
const standaloneProfiles = ['webgpu-wasm64-jspi', 'webgpu-wasm32-jspi'] as const;
const virtualPrefix = 'virtual:llama-cpp-browser-core/';
const standaloneBinaryIds = {
  'webgpu-wasm64-jspi': 'virtual:file-protocol-standalone/binary/llama-cpp-browser',
  'webgpu-wasm32-jspi': 'virtual:file-protocol-standalone/binary/llama-cpp-browser-wasm32-jspi',
} as const;

export function createLlamaCppBrowserBuild({ rootDir, mode }: { rootDir: string, mode: 'hosted' | 'standalone' }): {
  corePlugin: Plugin;
  embeddedBinaries: readonly StandaloneEmbeddedBinary[];
  nativeLicenseSource: NativeLicenseSource;
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
  const profiles: readonly LlamaCppProfile[] = isStandalone ? standaloneProfiles : hostedArtifactProfiles({ files, readArtifact });
  const gpuProfilingAvailable = !isStandalone && profiles.includes(gpuProfilingProfile);
  const availabilityId = '\0' + virtualPrefix + 'availability';
  const unavailableProfileId = '\0' + virtualPrefix + 'unavailable-gpu-profile';
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


  return {
    embeddedBinaries,
    nativeLicenseSource: { runtime: 'llama-cpp', kind: 'installed', rootDir, manifestPaths, files: new Set(files.keys()), readArtifact },
    corePlugin: {
      name: `naidan-llama-cpp-browser-core-${identity}`,
      enforce: 'pre',
      config() {
        // Keep the source behind this loader in dev as well as production.
        return { optimizeDeps: { exclude: ['llama-cpp-browser-core', ...profileSchema.options.map(profile => virtualPrefix + profile)] } };
      },
      resolveId(id) {
        if (id === virtualPrefix + 'availability') {
          return availabilityId;
        }
        if (!isStandalone && !gpuProfilingAvailable && id === virtualPrefix + gpuProfilingProfile) {
          return unavailableProfileId;
        }
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
      load(id) {
        if (id === availabilityId) {
          return `export const gpuProfilingAvailable = ${gpuProfilingAvailable};`;
        }
        if (id === unavailableProfileId) {
          return 'export default function() { throw new Error("GPU profiling artifact is not installed"); }';
        }
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
        this.addWatchFile(path.join(packageRoot, 'llama-cpp-browser-core/native-license-index.json'));
        for (const relative of licenseFiles) {
          this.addWatchFile(path.join(packageRoot, 'llama-cpp-browser-core', relative));
        }
        return readArtifact({ relative: `profiles/${entry.profile}/browser/core.mjs` }).data.toString('utf8');
      },
    },
  };
}

export const TEST_ONLY = {
};
