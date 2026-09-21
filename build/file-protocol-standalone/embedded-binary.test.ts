// @vitest-environment node
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { build, type Plugin } from 'vite';
import { afterEach, describe, expect, it } from 'vitest';
import { createEmbeddedBinaryPlugin, type StandaloneEmbeddedBinary } from './plugin/embedded-binary';
import { createExternalWasmGuardPlugin } from './plugin/external-wasm';

const directories: string[] = [];
function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'naidan-embedded-binary-')); directories.push(root);
  const bytes = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
  const filePath = path.join(root, 'input.wasm'); writeFileSync(filePath, bytes);
  const binary: StandaloneEmbeddedBinary = { virtualId: 'virtual:file-protocol-standalone/binary/test', filePath, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  writeFileSync(path.join(root, 'main.js'), `globalThis.loadBinary = () => import(${JSON.stringify(binary.virtualId)});`);
  return { root, bytes, binary };
}
afterEach(() => {
  for (const root of directories.splice(0)) rmSync(root, { recursive: true, force: true });
});
async function buildBinary({ root, binary, diagnostics }: { root: string, binary: StandaloneEmbeddedBinary, diagnostics: Record<string, unknown> }) {
  const result = await build({ configFile: false, root, base: './', logLevel: 'silent',
    plugins: [createEmbeddedBinaryPlugin({ binaries: [binary], diagnostics }), createExternalWasmGuardPlugin({ allowExternalWasmAssets: false })],
    build: { write: false, minify: false, modulePreload: false, rollupOptions: { input: path.join(root, 'main.js') } },
  });
  if (Array.isArray(result) || !('output' in result)) throw new Error('Unexpected fixture result');
  return result.output;
}
describe('standalone binary embedding', () => {
  it('creates one lazy compressed module with verified source provenance and no WASM sidecar', async () => {
    const { root, bytes, binary } = fixture(); const diagnostics: Record<string, unknown> = {};
    const output = await buildBinary({ root, binary, diagnostics });
    const payloads = output.filter(file => file.type === 'chunk' && Object.keys(file.modules).includes(`\0${binary.virtualId}`));
    expect(payloads).toHaveLength(1);
    const payload = payloads[0]; if (payload?.type !== 'chunk') throw new Error('Missing payload');
    const base64 = /base64\s*=\s*["']([^"']+)/.exec(payload.code)?.[1];
    if (!base64) throw new Error('Missing encoded payload');
    expect(gunzipSync(Buffer.from(base64, 'base64'))).toEqual(Buffer.from(bytes));
    expect(output.every(file => !/\.wasm(?:\.gz)?$/i.test(file.fileName))).toBe(true);
    expect(output.filter(file => file.type === 'chunk' && file.isEntry).every(file => file.type === 'chunk' && !file.code.includes(base64))).toBe(true);
    expect(diagnostics.embeddedBinaries).toEqual([expect.objectContaining({ sha256: binary.sha256, bytes: bytes.length, owners: [payload.fileName] })]);
  });
  it.each(['size', 'hash'] as const)('rejects an input with incorrect %s before emitting data', async corruption => {
    const { root, binary } = fixture();
    const input = corruption === 'size' ? { ...binary, bytes: 9 } : { ...binary, sha256: '0'.repeat(64) };
    await expect(buildBinary({ root, binary: input, diagnostics: {} })).rejects.toThrow('integrity mismatch');
  });
  it('rejects duplicate registrations and relative source paths', () => {
    const { binary } = fixture();
    expect(() => createEmbeddedBinaryPlugin({ binaries: [binary, binary], diagnostics: {} })).toThrow('duplicate');
    expect(() => createEmbeddedBinaryPlugin({ binaries: [{ ...binary, filePath: 'input.wasm' }], diagnostics: {} })).toThrow('Invalid');
  });
  it.each(['copied.wasm', 'nested/copied.wasm.gz'])('rejects publicDir sidecars before later packaging hooks: %s', async name => {
    const { root } = fixture();
    const asset = path.join(root, 'public', name); mkdirSync(path.dirname(asset), { recursive: true }); writeFileSync(asset, 'unexpected');
    writeFileSync(path.join(root, 'main.js'), 'globalThis.fixture = true;');
    let packaged = false;
    const packaging: Plugin = { name: 'packaging-must-not-run', writeBundle: { order: 'post', sequential: true, handler() {
      packaged = true;
    } } };
    await expect(build({ configFile: false, root, logLevel: 'silent', plugins: [createExternalWasmGuardPlugin({ allowExternalWasmAssets: false }), packaging],
      build: { write: true, rollupOptions: { input: path.join(root, 'main.js') } },
    })).rejects.toThrow('External WebAssembly');
    expect(packaged).toBe(false);
  });
});
