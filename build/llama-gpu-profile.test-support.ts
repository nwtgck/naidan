import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const diagnosticProfile = 'webgpu-wasm64-jspi-gpu-profile';
export const ordinaryProfiles = ['cpu-wasm32', 'webgpu-wasm64-jspi', 'webgpu-wasm32-jspi', 'webgpu-wasm32-asyncify'];

/** Small synthetic packaging fixtures, NOT a compiled inference runtime. */
export function createProfilingArtifactFixture({ diagnostic = 'complete', legacyCpu64 = false }: {
  diagnostic?: 'complete' | 'missing' | 'partial', legacyCpu64?: boolean,
} = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'naidan-gpu-package-'));
  const packageRoot = path.join(root, 'node_modules/llama-cpp-browser-core');
  const inventory: { path: string, bytes: number, sha256: string }[] = [];
  const prefix = 'llama-cpp-browser-core/';
  const sourceCommit = '1'.repeat(40);
  const profiles = [...ordinaryProfiles, ...(legacyCpu64 ? ['cpu-wasm64'] : [])];
  switch (diagnostic) {
  case 'complete': case 'partial': profiles.push(diagnosticProfile);
    break;
  case 'missing': break;
  default: {
    const exhaustive: never = diagnostic;
    throw new Error(String(exhaustive));
  }
  }
  const wasm = Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]);
  function put({ relative, data }: { relative: string, data: string | Buffer }) {
    const bytes = Buffer.from(data);
    const file = path.join(packageRoot, relative);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, bytes);
    return { path: relative, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  }
  for (const profile of profiles) {
    const extensions = diagnostic === 'partial' && profile === diagnosticProfile ? ['mjs', 'wasm'] : ['mjs', 'wasm', 'd.ts'];
    for (const extension of extensions) {
      const relative = `profiles/${profile}/browser/core.${extension}`;
      const data = extension === 'wasm' ? wasm : extension === 'mjs'
        ? `/* Copyright fixture authors; test use only. */\nexport default async function () { return { fixture: ${JSON.stringify(profile)} }; }\n`
        : 'export default function(): Promise<unknown>;\n';
      const entry = put({ relative: prefix + relative, data });
      inventory.push({ ...entry, path: relative });
    }
  }
  const license = put({ relative: prefix + 'LICENSE', data: 'Copyright fixture authors. Test fixture only.\n' });
  inventory.push({ ...license, path: 'LICENSE' });
  const manifest = put({ relative: prefix + 'manifest.json', data: JSON.stringify({ formatVersion: 2, sourceCommit, files: inventory }) });
  put({ relative: 'manifest.json', data: JSON.stringify({ formatVersion: 3, sourceCommit, runtimes: { 'llama-cpp': { manifest: prefix + 'manifest.json', manifestFormatVersion: 2 } }, files: [...inventory.map(entry => ({ ...entry, path: prefix + entry.path })), manifest] }) });
  return {
    root,
    packageRoot,
    wasm,
    profiles,
    file({ profile, name }: { profile: string, name: string }) {
      return path.join(packageRoot, prefix, 'profiles', profile, 'browser', name);
    },
    [Symbol.dispose]() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}
