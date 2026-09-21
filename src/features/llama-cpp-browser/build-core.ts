import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import MagicString from 'magic-string';
import { z } from 'zod';
import { normalizePath, type Plugin } from 'vite';
import { profileSchema, type LlamaCppProfile } from './types';
// eslint-disable-next-line local-rules-imports/prefer-root-alias-imports -- This build entry is also checked by tsconfig.node.json, which has no @ alias.
import type { StandaloneEmbeddedBinary } from '../file-protocol-standalone/build-types';

// Reviewed artifact commit: 61e9c34b3970cb036e99e274f28d54f4db0b0629.
// This is an exact-source adapter, not a general JavaScript syntax transform.
const coreHashes = {
  'webgpu-wasm64-jspi': '1c3853d8672243155c87ad76adbe0615dc1ea8dda3511b19cc7ec323f04b5ee8',
  'webgpu-wasm32-jspi': 'fc881a4036dc090bd947cec879e9ebcea7b54f83b39fbdfe30e189459802f738',
  'webgpu-wasm32-asyncify': '4228f3f146ef747fa149f976caf35928e5908d88edf96c0ae7e86071ed3b99fd',
  'cpu-wasm64': '2d9126fdffe538dd9b79acd44bdeb78189c3254c40d5d3c760b708335807bbb5',
  'cpu-wasm32': '0c94cc55e07709a73bf24d0b11dc9b0a9ccbde5ab8387095a553ee3746825676',
} as const satisfies Record<LlamaCppProfile, string>;
// Standalone selects either embedded JSPI artifact through Worker capability checks.
const standaloneProfiles = ['webgpu-wasm64-jspi', 'webgpu-wasm32-jspi'] as const;
const virtualPrefix = 'virtual:llama-cpp-browser-core/';
const standaloneWasm = {
  'webgpu-wasm64-jspi': { virtualId: 'virtual:file-protocol-standalone/binary/llama-cpp-browser', sha256: '404b128b7ba76208a8ec6d3f5726572d44139ee95051103233577124853ce090' },
  'webgpu-wasm32-jspi': { virtualId: 'virtual:file-protocol-standalone/binary/llama-cpp-browser-wasm32-jspi', sha256: 'd834485354f43d03d0cd32d87e80a79473699f2505f2ddd1e58eed032c49c2ea' },
} as const;
const manifestSchema = z.object({ files: z.array(z.object({
  path: z.string(), bytes: z.number().int().nonnegative(), sha256: z.string().regex(/^[0-9a-f]{64}$/),
})) });

/** Version-bound packaging adapter. The upstream browser/version checks are preserved. */
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
  replace({
    before: 'var ENVIRONMENT_IS_NODE=globalThis.process?.versions?.node&&globalThis.process?.type!="renderer";',
    after: '/* Naidan fix: hosted and standalone use the browser runtime, never Node.js. */var ENVIRONMENT_IS_NODE=false;',
  });
  replace({
    before: 'if(ENVIRONMENT_IS_NODE){const{createRequire}=await import("node:module");var require=createRequire(import.meta.url)}',
    after: '/* Naidan fix: exclude Node.js imports before Vite dependency analysis. */',
  });
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
  switch (profile) {
  case 'cpu-wasm32': case 'webgpu-wasm32-jspi': case 'webgpu-wasm32-asyncify':
    replace({
      before: 'if(ENVIRONMENT_IS_NODE){var nodeCrypto=require("node:crypto");return view=>(nodeCrypto.randomFillSync(view),0)}',
      after: '/* Naidan fix: keep the existing browser random source, without a Node.js dependency. */',
    });
    break;
  case 'cpu-wasm64': case 'webgpu-wasm64-jspi': break;
  default: { const exhaustive: never = profile; throw new Error(`Unhandled profile: ${exhaustive}`); }
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
    const core = readArtifact({ relative: `profiles/${profile}/core.mjs` });
    if (core.sha256 !== coreHashes[profile]) throw new Error(`Unreviewed browser core artifact: ${profile}`);
    // Validate at plugin creation too: an optimizer cache must not hide a changed input.
    const transformed = transformBrowserCore({ source: core.data.toString('utf8'), id: core.filePath, profile });
    return { profile, core, transformed };
  });
  const embeddedBinaries = isStandalone ? standaloneProfiles.map(profile => {
    const wasm = readArtifact({ relative: `profiles/${profile}/core.wasm` });
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
