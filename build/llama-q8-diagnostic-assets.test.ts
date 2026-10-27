// @vitest-environment node
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { createLlamaCppBrowserBuild } from '../src/features/llama-cpp-browser/build-core';
import { createProfilingArtifactFixture, diagnosticProfile } from './llama-gpu-profile.test-support';

const schemaBytes = Buffer.from(`\
{"fixture":"opaque extension schema bytes"}
`);
const typeBytes = Buffer.from(`\
export type DiagnosticFixture = unknown;
`);
const schemaRelativePath = `${diagnosticProfile}/q8-diagnostic-v1.schema.json`;
const assetPath = `profiles/${schemaRelativePath}`;
const inventorySchema = z.object({ files: z.array(z.object({ path: z.string(), bytes: z.number(), sha256: z.string() })) }).passthrough();

function installSidecars({ fixture, parts }: { fixture: ReturnType<typeof createProfilingArtifactFixture>, parts: readonly ('schema.json' | 'functions.d.ts')[] }) {
  const innerPath = path.join(fixture.packageRoot, 'llama-cpp-browser-core/manifest.json');
  const rootPath = path.join(fixture.packageRoot, 'manifest.json');
  const inner = inventorySchema.parse(JSON.parse(readFileSync(innerPath, 'utf8')));
  const root = inventorySchema.parse(JSON.parse(readFileSync(rootPath, 'utf8')));
  for (const part of parts) {
    const bytes = part === 'schema.json' ? schemaBytes : typeBytes;
    const relative = `profiles/${diagnosticProfile}/browser/q8-diagnostic-v1.${part}`;
    const entry = { path: relative, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
    writeFileSync(path.join(fixture.packageRoot, 'llama-cpp-browser-core', relative), bytes);
    inner.files.push(entry);
    root.files.push({ ...entry, path: 'llama-cpp-browser-core/' + relative });
  }
  const innerBytes = Buffer.from(JSON.stringify(inner));
  writeFileSync(innerPath, innerBytes);
  const innerEntry = root.files.find(file => file.path === 'llama-cpp-browser-core/manifest.json');
  if (!innerEntry) {
    throw new Error('Missing fixture manifest entry');
  }
  innerEntry.bytes = innerBytes.length;
  innerEntry.sha256 = createHash('sha256').update(innerBytes).digest('hex');
  writeFileSync(rootPath, JSON.stringify(root));
}

async function inspectBuild({ root, mode }: { root: string, mode: 'hosted' | 'standalone' }) {
  const { corePlugin, runtimeAssetsPlugin } = createLlamaCppBrowserBuild({ rootDir: root, mode });
  const { resolveId, load } = corePlugin;
  if (typeof resolveId !== 'function' || typeof load !== 'function' || typeof runtimeAssetsPlugin.generateBundle !== 'function') {
    throw new Error('Expected asset plugin hooks');
  }
  const availability = await resolveId.call({} as never, 'virtual:llama-cpp-browser-core/availability', undefined, {} as never);
  const watched: string[] = [];
  const source = await load.call({ addWatchFile: (file: string) => watched.push(file) } as never, String(availability));
  const assets = new Map<string, Uint8Array>();
  await runtimeAssetsPlugin.generateBundle.call({
    emitFile(file: { fileName: string, source: Uint8Array }) {
      assets.set(file.fileName, file.source);
      return file.fileName;
    },
  } as never, {} as never, {} as never, false);
  return { source, assets, watched, pluginName: corePlugin.name };
}

describe('optional Q8 diagnostic schema assets', () => {
  it.each(['complete', 'missing'] as const)('keeps older packages buildable with a %s profiling runtime and no extension', async diagnostic => {
    using fixture = createProfilingArtifactFixture({ diagnostic });
    const result = await inspectBuild({ root: fixture.root, mode: 'hosted' });
    expect(result.source).toContain('q8KernelDiagnosticSchemaAsset = undefined;');
    expect([...result.assets.keys()].every(name => name.endsWith('/core.wasm.gz'))).toBe(true);
    expect(result.watched).toHaveLength(2);
  });

  it('emits checked schema bytes and advertises their asset identity without a package import', async () => {
    using fixture = createProfilingArtifactFixture();
    const original = await inspectBuild({ root: fixture.root, mode: 'hosted' });
    installSidecars({ fixture, parts: ['schema.json', 'functions.d.ts'] });
    const result = await inspectBuild({ root: fixture.root, mode: 'hosted' });
    expect(result.assets.get('llama-cpp-browser-runtime/' + assetPath)).toEqual(schemaBytes);
    expect([...result.assets.keys()].some(name => name.endsWith('.d.ts'))).toBe(false);
    expect(result.source).toContain(`q8KernelDiagnosticSchemaAsset = ${JSON.stringify({
      relativePath: schemaRelativePath,
      bytes: schemaBytes.length,
      sha256: createHash('sha256').update(schemaBytes).digest('hex'),
    })};`);
    expect(result.source).not.toContain('import');
    expect(result.pluginName).not.toBe(original.pluginName);
    expect(result.watched).toContain(fixture.file({ profile: diagnosticProfile, name: 'q8-diagnostic-v1.schema.json' }));
  });

  it('serves the checked JSON under the configured development base without a socket', async () => {
    using fixture = createProfilingArtifactFixture();
    installSidecars({ fixture, parts: ['schema.json', 'functions.d.ts'] });
    const { runtimeAssetsPlugin } = createLlamaCppBrowserBuild({ rootDir: fixture.root, mode: 'hosted' });
    if (typeof runtimeAssetsPlugin.configureServer !== 'function') {
      throw new Error('Expected the development asset hook');
    }
    let middleware: ((request: IncomingMessage, response: ServerResponse, next: (error?: unknown) => void) => void) | undefined;
    await runtimeAssetsPlugin.configureServer.call({} as never, {
      config: { base: '/nested/' },
      middlewares: {
        use(handler: typeof middleware) {
          middleware = handler;
        },
      },
    } as never);
    if (!middleware) {
      throw new Error('Expected the development asset middleware');
    }
    const response = Promise.withResolvers<Uint8Array | undefined>();
    const headers = new Map<string, string>();
    middleware({ url: `/nested/llama-cpp-browser-runtime/${assetPath}` } as IncomingMessage, {
      setHeader(name: string, value: string) {
        headers.set(name, value);
      },
      end(value: Uint8Array | undefined) {
        response.resolve(value);
      },
    } as ServerResponse, error => response.reject(error ?? new Error('The asset route was not handled')));
    expect(await response.promise).toEqual(schemaBytes);
    expect(headers.get('Content-Type')).toBe('application/json');
    expect(headers.has('Content-Encoding')).toBe(false);
  });

  it.each(['schema.json', 'functions.d.ts'] as const)('rejects a partial extension containing only %s', part => {
    using fixture = createProfilingArtifactFixture();
    installSidecars({ fixture, parts: [part] });
    expect(() => createLlamaCppBrowserBuild({ rootDir: fixture.root, mode: 'hosted' })).toThrow('Incomplete Q8 diagnostic extension artifact');
  });

  it.each(['schema.json', 'functions.d.ts'] as const)('rejects corrupt %s against the published inventory', part => {
    using fixture = createProfilingArtifactFixture();
    installSidecars({ fixture, parts: ['schema.json', 'functions.d.ts'] });
    writeFileSync(fixture.file({ profile: diagnosticProfile, name: `q8-diagnostic-v1.${part}` }), 'corrupt');
    expect(() => createLlamaCppBrowserBuild({ rootDir: fixture.root, mode: 'hosted' })).toThrow('integrity mismatch');
  });

  it('does not inspect or emit diagnostic sidecars for the standalone selector', async () => {
    using fixture = createProfilingArtifactFixture();
    installSidecars({ fixture, parts: ['schema.json'] });
    writeFileSync(fixture.file({ profile: diagnosticProfile, name: 'q8-diagnostic-v1.schema.json' }), 'corrupt');
    const result = await inspectBuild({ root: fixture.root, mode: 'standalone' });
    expect(result.source).toContain('q8KernelDiagnosticSchemaAsset = undefined;');
    expect(result.assets.has('llama-cpp-browser-runtime/' + assetPath)).toBe(false);
    expect(result.assets.size).toBe(2);
  });
});
