// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { build } from 'vite';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createNodeEnvBoundaryPlugin } from './node-env-boundary';
import { pathToFileURL } from 'node:url';
import { docsCompilerConfig } from '../docs/build/compiler';

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'naidan-env-boundary-'));
  return {
    root,
    async [Symbol.asyncDispose]() {
      await rm(root, { recursive: true, force: true });
    },
  };
}

async function bundle({ root, alias = {} }: { root: string, alias?: Record<string, string> }) {
  return build({
    configFile: false,
    root,
    logLevel: 'silent',
    plugins: [createNodeEnvBoundaryPlugin({ rootDir: root })],
    worker: { plugins: () => [createNodeEnvBoundaryPlugin({ rootDir: root })] },
    resolve: { alias },
    // An env replacement must not hide the forbidden module from the boundary.
    define: { 'process.env.PATH': '"replaced"' },
    build: { write: false, minify: false, lib: { entry: path.join(root, 'main.ts'), formats: ['es'], fileName: 'bundle' } },
  });
}

async function prepare({ root, entry }: { root: string, entry: string }) {
  await mkdir(path.join(root, 'build'));
  await writeFile(path.join(root, 'main.ts'), entry);
  await writeFile(path.join(root, 'build/node-env.ts'), 'export const READ_ENV_PATH = () => process.env.PATH;');
  await writeFile(path.join(root, 'facade.ts'), 'export { READ_ENV_PATH } from "./build/node-env";');
}

describe('Node environment browser boundary', () => {
  it.each([
    'export { READ_ENV_PATH } from "./build/node-env";',
    'import "./build/node-env"; export const value = 1;',
    'export const load = () => import("./build/node-env");',
    'export { READ_ENV_PATH } from "./facade";',
    'export const load = () => import("./build/node-env.ts?raw");',
    'export const worker = () => new Worker(new URL("./build/node-env.ts", import.meta.url), { type: "module" });',
    'export const worker = () => new Worker(new URL("./facade.ts", import.meta.url), { type: "module" });',
    'export const all = import.meta.glob("./build/*.ts", { eager: true });',
  ])('rejects before emitting browser code: %s', async entry => {
    await using owned = await fixture();
    await prepare({ root: owned.root, entry });
    await expect(bundle({ root: owned.root })).rejects.toThrow('Node environment registry reached a browser bundle');
  });

  it('checks an innocent alias after resolution', async () => {
    await using owned = await fixture();
    await prepare({ root: owned.root, entry: 'export { READ_ENV_PATH } from "safe-alias";' });
    await expect(bundle({ root: owned.root, alias: { 'safe-alias': path.join(owned.root, 'build/node-env.ts') } })).rejects.toThrow('Node environment registry reached a browser bundle');
  });

  it('guards Docs pages and Docs workers as well as the main application', async () => {
    await using owned = await fixture();
    await prepare({ root: owned.root, entry: 'export { READ_ENV_PATH } from "./facade";' });
    await mkdir(path.join(owned.root, 'docs'));
    const config = docsCompilerConfig({ root: path.join(owned.root, 'docs') });
    await expect(build({
      ...config,
      configFile: false,
      logLevel: 'silent',
      build: { write: false, lib: { entry: path.join(owned.root, 'main.ts'), formats: ['es'] } },
    })).rejects.toThrow('Node environment registry reached a browser bundle');
    await writeFile(path.join(owned.root, 'main.ts'), 'export const worker = () => new Worker(new URL("./facade.ts", import.meta.url), { type: "module" });');
    await expect(build({
      ...config,
      configFile: false,
      logLevel: 'silent',
      build: { write: false, lib: { entry: path.join(owned.root, 'main.ts'), formats: ['es'] } },
    })).rejects.toThrow('Node environment registry reached a browser bundle');
  });

  it('rejects filesystem URLs and file URLs during loading', () => {
    const root = process.cwd();
    const registry = path.join(root, 'build/node-env.ts').replaceAll('\\', '/');
    const plugin = createNodeEnvBoundaryPlugin({ rootDir: root });
    const hook = plugin.load;
    if (typeof hook !== 'function') {
      throw new Error('Expected a callable load hook');
    }
    for (const id of [`/@fs/${registry}`, `/@fs${registry.startsWith('/') ? registry : `/${registry}`}`, pathToFileURL(registry).href + '?raw']) {
      // This synchronous hook does not use the Vite context.
      expect(() => Reflect.apply(hook, undefined, [id])).toThrow('Node environment registry reached a browser bundle');
    }
  });

  it('permits browser environment metadata and an unrelated filename', async () => {
    await using owned = await fixture();
    await writeFile(path.join(owned.root, 'main.ts'), 'export { value } from "./node-env"; export const development = import.meta.env.DEV;');
    await writeFile(path.join(owned.root, 'node-env.ts'), 'export const value = 42;');
    await expect(bundle({ root: owned.root })).resolves.toBeDefined();
  });
});
