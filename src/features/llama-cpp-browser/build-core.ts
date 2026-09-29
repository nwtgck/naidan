import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import MagicString from 'magic-string';
import { z } from 'zod';
import { normalizePath, type Plugin } from 'vite';
import { profileSchema, type LlamaCppProfile } from './types';
// eslint-disable-next-line local-rules-imports/prefer-root-alias-imports -- This build entry is also checked by tsconfig.node.json, which has no @ alias.
import type { StandaloneEmbeddedBinary } from '../file-protocol-standalone/build-types';

// Reviewed browser variant artifact commit: 8eb01e7aa8ad0968a6dfba26d938817d4a441b31.
// This is an exact-source adapter, not a general JavaScript syntax transform.
const coreHashes = {
  'webgpu-wasm64-jspi': 'ff3786e68fa11050df3950980116e19988ef790da382b3eb3abd7ef2c5424921',
  'webgpu-wasm32-jspi': 'c676739632d85c50ab7798df591d7fe4b59a5dedfb068756837bf775e9a6f785',
  'webgpu-wasm32-asyncify': '0bef53602f8502b81779f460e28770057f48d1665238b3537fb943a0fc0cc532',
  'cpu-wasm64': '6e499ce22b0eea54a204713d3c8fa99b5971ac9ccf44edc4d7767f50ef7de298',
  'cpu-wasm32': 'd5dc3e3115cacaff3e7dab6122b96b4c77f1a69cc7aee21b8b2844ff31a6bc86',
} as const satisfies Record<LlamaCppProfile, string>;
// Standalone selects either embedded JSPI artifact through Worker capability checks.
const standaloneProfiles = ['webgpu-wasm64-jspi', 'webgpu-wasm32-jspi'] as const;
const virtualPrefix = 'virtual:llama-cpp-browser-core/';
const standaloneWasm = {
  'webgpu-wasm64-jspi': { virtualId: 'virtual:file-protocol-standalone/binary/llama-cpp-browser', sha256: 'e492f5b73ed75ea70f330e18febe90d43a624e3ae2bc2e67e97e10f686fcb507' },
  'webgpu-wasm32-jspi': { virtualId: 'virtual:file-protocol-standalone/binary/llama-cpp-browser-wasm32-jspi', sha256: '8ea80cff58eb529a31f166628c7797f83142300f01941cf8e0bfb9d2c07589ee' },
} as const;
const manifestSchema = z.object({ formatVersion: z.literal(2), files: z.array(z.object({
  path: z.string(), bytes: z.number().int().nonnegative(), sha256: z.string().regex(/^[0-9a-f]{64}$/),
})) });

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
    start: 'var readAsync,readBinary;', end: 'var out=console.log.bind(console);',
    replacement: '/* Naidan fix: Naidan supplies wasmBinary in every build mode; external runtime reads must never be attempted. */var readBinary=()=>{throw new Error("Browser core requires supplied wasmBinary")};var readAsync=async()=>readBinary();',
  });
  replace({
    before: 'function findWasmBinary(){if(Module["locateFile"]){return locateFile("core.wasm")}return new URL("core.wasm",import.meta.url).href}',
    after: '/* Naidan fix: prevent external WASM emission, including when locateFile is not supplied. */function findWasmBinary(){assert(wasmBinary&&wasmBinary.byteLength,"Browser core requires supplied wasmBinary");return "naidan:supplied-core.wasm"}',
  });
  replaceBetween({
    start: 'async function instantiateAsync(binary,binaryFile,imports){', end: 'function getWasmImports(){',
    replacement: '/* Naidan fix: both builds supply bytes; never fall back to network or file-fetch. */async function instantiateAsync(binary,binaryFile,imports){assert(binary&&binary.byteLength,"Browser core requires supplied wasmBinary");return instantiateArrayBuffer(binaryFile,imports)}',
  });
  replace({
    before: 'if(file==wasmBinaryFile&&wasmBinary){return new Uint8Array(wasmBinary)}',
    after: '/* Naidan fix: keep the supplied byte view, including its offset, without copying the complete Wasm. */if(file==wasmBinaryFile&&wasmBinary){assert(ArrayBuffer.isView(wasmBinary)&&wasmBinary.BYTES_PER_ELEMENT===1,"Expected Wasm byte view");return wasmBinary}',
  });
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
  const artifactRoot = realpathSync(path.join(rootDir, 'node_modules/llama-cpp-browser-core'));
  const manifestPath = path.join(artifactRoot, 'manifest.json');
  const manifest = manifestSchema.parse(JSON.parse(readFileSync(manifestPath, 'utf8')));
  const files = new Map<string, z.infer<typeof manifestSchema>['files'][number]>();
  for (const file of manifest.files) {
    if (files.has(file.path)) throw new Error('Duplicate core manifest entry');
    files.set(file.path, file);
  }
  function readArtifact({ relative }: { relative: string }) {
    if (relative.split('/').some(part => !part || part === '.' || part === '..') || relative.includes('\\')) throw new Error('Invalid core artifact path');
    const file = files.get(relative);
    if (!file) throw new Error(`Missing core artifact: ${relative}`);
    const filePath = realpathSync(path.join(artifactRoot, relative));
    if (!filePath.startsWith(artifactRoot + path.sep)) throw new Error('Core artifact escapes package');
    const data = readFileSync(filePath);
    if (data.length !== file.bytes || createHash('sha256').update(data).digest('hex') !== file.sha256) throw new Error(`Core artifact integrity mismatch: ${relative}`);
    return { filePath, data, ...file };
  }
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
  const profileRoot = normalizePath(path.join(artifactRoot, 'profiles')) + '/';
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
        this.addWatchFile(manifestPath);
        this.addWatchFile(entry.core.filePath);
        for (const relative of licenseFiles) this.addWatchFile(path.join(artifactRoot, relative));
        return transformBrowserCore({ source: readFileSync(entry.core.filePath, 'utf8'), id, profile: entry.profile });
      },
    },
  };
}
export const TEST_ONLY = {
  embeddedNotices,
};
