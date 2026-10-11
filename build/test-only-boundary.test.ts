import { describe, expect, it } from 'vitest';
import { build } from 'vite';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createTestOnlyBoundaryPlugin } from './test-only-boundary';

async function createFixture({ entry, helperName }: { entry: string, helperName: string }) {
  const root = await mkdtemp(path.join(tmpdir(), 'naidan-test-boundary-'));
  try {
    await writeFile(path.join(root, 'main.ts'), entry);
    await writeFile(path.join(root, helperName), 'export const value = 42;');
    return root;
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

async function bundle({ root, alias }: { root: string, alias: Record<string, string> }) {
  return build({
    configFile: false,
    root,
    logLevel: 'silent',
    plugins: [createTestOnlyBoundaryPlugin()],
    resolve: { alias },
    worker: { plugins: () => [createTestOnlyBoundaryPlugin()] },
    build: { write: false, minify: false, lib: { entry: path.join(root, 'main.ts'), formats: ['es'], fileName: 'bundle' } },
  });
}

describe('test-only production boundary', () => {
  it.each([
    { entry: 'export { value } from "./fixture.test-support";', helperName: 'fixture.test-support.ts' },
    { entry: 'import "./fixture.test-support"; export const value = 1;', helperName: 'fixture.test-support.ts' },
    { entry: 'export const load = () => import("./fixture.test-support");', helperName: 'fixture.test-support.ts' },
    { entry: 'export { value } from "./fixture.test";', helperName: 'fixture.test.ts' },
    { entry: 'export const raw = import("./fixture.test-support.ts?raw");', helperName: 'fixture.test-support.ts' },
  ])('rejects a test module before emission: $entry', async ({ entry, helperName }) => {
    const root = await createFixture({ entry, helperName });
    await using _fixture = {
      async [Symbol.asyncDispose]() {
        await rm(root, { recursive: true, force: true });
      },
    };
    await expect(bundle({ root, alias: {} })).rejects.toThrow('Test-only module reached');
  });

  it('checks the resolved filename behind an innocent alias', async () => {
    const root = await createFixture({ entry: 'export { value } from "safe-alias";', helperName: 'fixture.test-support.ts' });
    await using _fixture = {
      async [Symbol.asyncDispose]() {
        await rm(root, { recursive: true, force: true });
      },
    };
    await expect(bundle({ root, alias: { 'safe-alias': path.join(root, 'fixture.test-support.ts') } })).rejects.toThrow('Test-only module reached');
  });

  it('rejects a test helper reached indirectly through a normal facade', async () => {
    const root = await createFixture({ entry: 'export { value } from "./facade";', helperName: 'fixture.test-support.ts' });
    await using _fixture = {
      async [Symbol.asyncDispose]() {
        await rm(root, { recursive: true, force: true });
      },
    };
    await writeFile(path.join(root, 'facade.ts'), 'export { value } from "./fixture.test-support";');
    await expect(bundle({ root, alias: {} })).rejects.toThrow('Test-only module reached');
  });

  it('rejects a worker entry with a test-support suffix', async () => {
    const root = await createFixture({ entry: 'export const worker = () => new Worker(new URL("./fixture.test-support.ts", import.meta.url), { type: "module" });', helperName: 'fixture.test-support.ts' });
    await using _fixture = {
      async [Symbol.asyncDispose]() {
        await rm(root, { recursive: true, force: true });
      },
    };
    await expect(bundle({ root, alias: {} })).rejects.toThrow('Test-only module reached');
  });

  it('rejects test support selected by a broad glob', async () => {
    const root = await createFixture({ entry: 'export const modules = import.meta.glob("./fixtures/*.ts");', helperName: 'unused.ts' });
    await using _fixture = {
      async [Symbol.asyncDispose]() {
        await rm(root, { recursive: true, force: true });
      },
    };
    await mkdir(path.join(root, 'fixtures'));
    await writeFile(path.join(root, 'fixtures', 'resource.test-support.ts'), 'export const value = 1;');
    await expect(bundle({ root, alias: {} })).rejects.toThrow('Test-only module reached');
  });

  it.each(['src/test-tmp', 'src/lint-rule-tmp', 'eslint-local-rules/fixtures'])('rejects ignored negative fixtures reached by an alias: %s', async directory => {
    const root = await createFixture({ entry: 'export { value } from "safe-alias";', helperName: 'unused.ts' });
    await using _fixture = {
      async [Symbol.asyncDispose]() {
        await rm(root, { recursive: true, force: true });
      },
    };
    const fixtures = path.join(root, directory);
    await mkdir(fixtures, { recursive: true });
    const filename = path.join(fixtures, 'negative.ts');
    await writeFile(filename, 'export const value = 42;');
    await expect(bundle({ root, alias: { 'safe-alias': filename } })).rejects.toThrow('Test-only module reached');
  });

  it('allows ordinary implementation modules and explicit cleanup methods', async () => {
    const root = await createFixture({ entry: 'export { value } from "./resource"; export const resource = { dispose() {} };', helperName: 'resource.ts' });
    await using _fixture = {
      async [Symbol.asyncDispose]() {
        await rm(root, { recursive: true, force: true });
      },
    };
    await expect(bundle({ root, alias: {} })).resolves.toBeDefined();
  });
});
