import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import MagicString from 'magic-string';
import { normalizePath, type Plugin } from 'vite';
import { profileSchema, usesWebGpu, type LlamaCppProfile } from './types';
import { readLlamaArtifactPackage } from './build-artifact-package';
// eslint-disable-next-line local-rules-imports/prefer-root-alias-imports -- This build entry is also checked by tsconfig.node.json, which has no @ alias.
import type { StandaloneEmbeddedBinary } from '../file-protocol-standalone/build-types';

// Reviewed browser variant artifact commit: e21ab5e036cdd3d81b509459f1979b05885d407a.
// This is an exact-source adapter, not a general JavaScript syntax transform.
const coreHashes = {
  'webgpu-wasm64-jspi': '66934d8af20b38746be1560a20813380e7a05a724989f43ea3c31d1f71ed77b4',
  'webgpu-wasm32-jspi': '377ef89481856eb96e6d389b7099eb1c94b0c2d948b79a3e33ef91e09b281224',
  'webgpu-wasm32-asyncify': '88becdf64b90353573015d0869cbc26d12b839d9c873c0b573f1d0b5436aa37b',
  'cpu-wasm64': '8daa1e0254f43ea5b34243997ca4b18a5360226d4dc4f751c3c55ff927cd4643',
  'cpu-wasm32': 'a1886300c3261f0ca3caa3a99e0a7081ba6c20c51f3d09d5bf761b62253fda45',
} as const satisfies Record<LlamaCppProfile, string>;
// Standalone selects either embedded JSPI artifact through Worker capability checks.
const standaloneProfiles = ['webgpu-wasm64-jspi', 'webgpu-wasm32-jspi'] as const;
const virtualPrefix = 'virtual:llama-cpp-browser-core/';
const standaloneWasm = {
  'webgpu-wasm64-jspi': { virtualId: 'virtual:file-protocol-standalone/binary/llama-cpp-browser', sha256: '5cfbb41f0a8aaa2e1914f431b9d532768a5610d4110ed78662d09aef35208e38' },
  'webgpu-wasm32-jspi': { virtualId: 'virtual:file-protocol-standalone/binary/llama-cpp-browser-wasm32-jspi', sha256: '85e38766a768fe7491e39f83dd12c3e307cf02bed1a21e22b91a8933d7b9d93b' },
} as const;

/** Version-bound adapter for the browser variant, which has no upstream version guards. */
export function transformBrowserCore({ source, id, profile }: { source: string, id: string, profile: LlamaCppProfile }) {
  if (createHash('sha256').update(source).digest('hex') !== coreHashes[profile]) {
    throw new Error('Unreviewed llama.cpp browser core; review the pinned packaging adapter before updating it');
  }
  const transformed = new MagicString(source);
  function replace({ before, after }: { before: string, after: string }): void {
    const start = source.indexOf(before);
    if (start < 0 || source.indexOf(before, start + before.length) >= 0) throw new Error('Browser core adapter boundary changed');
    transformed.overwrite(start, start + before.length, after);
  }
  function replaceBetween({ start, end, replacement }: { start: string, end: string, replacement: string }): void {
    const from = source.indexOf(start); const to = source.indexOf(end, from + start.length);
    if (from < 0 || to < 0) throw new Error('Browser core adapter range changed');
    replace({ before: source.slice(from, to), after: replacement });
  }
  replaceBetween({
    start: 'var readAsync,readBinary;',
    end: 'var out=console.log.bind(console);',
    replacement: '/* Naidan fix: Naidan supplies wasmBinary in every build mode; external runtime reads must never be attempted. */var readBinary=()=>{throw new Error("Browser core requires supplied wasmBinary")};var readAsync=async()=>readBinary();',
  });
  replace({
    before: 'function findWasmBinary(){if(Module["locateFile"]){return locateFile("core.wasm")}return new URL("core.wasm",import.meta.url).href}',
    after: '/* Naidan fix: prevent external WASM emission, including when locateFile is not supplied. */function findWasmBinary(){assert(wasmBinary&&wasmBinary.byteLength,"Browser core requires supplied wasmBinary");return "naidan:supplied-core.wasm"}',
  });
  replaceBetween({
    start: 'async function instantiateAsync(binary,binaryFile,imports){',
    end: 'function getWasmImports(){',
    replacement: '/* Naidan fix: both builds supply bytes; never fall back to network or file-fetch. */async function instantiateAsync(binary,binaryFile,imports){assert(binary&&binary.byteLength,"Browser core requires supplied wasmBinary");return instantiateArrayBuffer(binaryFile,imports)}',
  });
  replace({
    before: 'if(file==wasmBinaryFile&&wasmBinary){return new Uint8Array(wasmBinary)}',
    after: '/* Naidan fix: keep the supplied byte view, including its offset, without copying the complete Wasm. */if(file==wasmBinaryFile&&wasmBinary){assert(ArrayBuffer.isView(wasmBinary)&&wasmBinary.BYTES_PER_ELEMENT===1,"Expected Wasm byte view");return wasmBinary}',
  });
  if (usesWebGpu({ profile })) {
    // Scope the compatibility facade to this native module. Never patch the
    // browser's navigator or GPU prototypes, and never edit the supplied Wasm.
    replace({
      before: 'var _scriptName=import.meta.url;',
      after: 'var _scriptName=import.meta.url;var navigator=Module["naidanNavigator"]??globalThis.navigator;',
    });
  }
  return { code: transformed.toString(), map: transformed.generateMap({ source: id, includeContent: true, hires: true }) };
}


/** Preserve complete legal comment blocks instead of redistributing megabytes of
 * unrelated C/C++ header implementation just to include their embedded notices. */
function embeddedNotices({ source }: { source: string }): string {
  const comments = source.match(/\/\*[\s\S]*?\*\/|(?:^[ \t]*\/\/[^\n]*(?:\n|$))+/gm) ?? [];
  const notices = comments.filter(comment => /copyright|licen[cs]e|public domain|permission is hereby|redistribution/i.test(comment));
  if (notices.length === 0) throw new Error('Missing embedded native license notices');
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
    default: { const exhaustive: never = mode; throw new Error(`Unhandled build mode: ${exhaustive}`); }
    }
  })();
  const profiles: readonly LlamaCppProfile[] = isStandalone ? standaloneProfiles : profileSchema.options;
  const cores = profiles.map(profile => {
    const core = readArtifact({ relative: `profiles/${profile}/browser/core.mjs` });
    if (core.sha256 !== coreHashes[profile]) throw new Error(`Unreviewed browser core artifact: ${profile}`);
    // Validate at plugin creation too: an optimizer cache must not hide a changed input.
    const transformed = transformBrowserCore({ source: core.data.toString('utf8'), id: core.filePath, profile });
    return { profile, core, transformed };
  });
  const embeddedBinaries = isStandalone ? standaloneProfiles.map(profile => {
    const wasm = readArtifact({ relative: `profiles/${profile}/browser/core.wasm` });
    const expected = standaloneWasm[profile];
    if (wasm.sha256 !== expected.sha256) throw new Error('Unreviewed standalone Wasm artifact');
    return { virtualId: expected.virtualId, filePath: wasm.filePath, bytes: wasm.bytes, sha256: wasm.sha256 };
  }) : [];
  const profileRoot = normalizePath(artifactProfiles) + '/';
  const byId = new Map(cores.map(entry => [normalizePath(entry.core.filePath), entry]));
  const byVirtualId = new Map(cores.map(entry => [virtualPrefix + entry.profile, normalizePath(entry.core.filePath)]));
  const identity = createHash('sha256').update(cores.map(entry => entry.transformed.code).join('\0')).digest('hex');

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
        return { optimizeDeps: { exclude: ['llama-cpp-browser-core', ...Object.keys(coreHashes).map(profile => virtualPrefix + profile)] } };
      },
      resolveId(id) {
        if (!id.startsWith(virtualPrefix)) return;
        const resolved = byVirtualId.get(id);
        if (!resolved) throw new Error(`Unavailable llama.cpp core import: ${id}`);
        // The real package path keeps license collection and module provenance intact.
        return resolved;
      },
      generateBundle() {
        this.emitFile({ type: 'asset', fileName: 'llama-cpp-browser-native-licenses.txt', source: licenseText });
      },
      load(id) {
        const filePath = normalizePath(id.split('?')[0]!);
        if (!filePath.startsWith(profileRoot)) return;
        // Reject other native modules before tree shaking can hide their provenance.
        const entry = byId.get(filePath);
        if (!entry) throw new Error(`Unavailable llama.cpp artifact: ${filePath}`);
        for (const manifestPath of manifestPaths) this.addWatchFile(manifestPath);
        this.addWatchFile(entry.core.filePath);
        for (const relative of licenseFiles) this.addWatchFile(path.join(packageRoot, 'llama-cpp-browser-core', relative));
        return transformBrowserCore({ source: readFileSync(entry.core.filePath, 'utf8'), id, profile: entry.profile });
      },
    },
  };
}
export const TEST_ONLY = {
  embeddedNotices,
};
