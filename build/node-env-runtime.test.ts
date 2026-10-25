// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { build } from 'vite';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createStableDiffusionCppBrowserBuild } from '../src/features/stable-diffusion-cpp-browser/build-runtime';

afterEach(() => vi.unstubAllEnvs());

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'naidan-env-runtime-'));
  return {
    root,
    async [Symbol.asyncDispose]() {
      await rm(root, { recursive: true, force: true });
    },
  };
}

describe('image runtime environment timing', () => {
  it('reads only on first use, caches that result, then reads again at buildStart', async () => {
    await using owned = await fixture();
    const missing = path.join(owned.root, 'missing-image-artifacts');
    vi.stubEnv('NAIDAN_STABLE_DIFFUSION_CORE_DIR', missing);
    const runtime = createStableDiffusionCppBrowserBuild({ rootDir: owned.root, mode: 'hosted' });
    vi.stubEnv('NAIDAN_STABLE_DIFFUSION_CORE_DIR', undefined);
    expect(runtime.getNativeLicenseSource()).toBeUndefined();
    vi.stubEnv('NAIDAN_STABLE_DIFFUSION_CORE_DIR', missing);
    expect(runtime.getNativeLicenseSource()).toBeUndefined();
    await writeFile(path.join(owned.root, 'main.ts'), 'export { default } from "virtual:stable-diffusion-cpp-browser/config";');
    await expect(build({
      configFile: false,
      root: owned.root,
      logLevel: 'silent',
      plugins: [runtime.plugin],
      build: { write: false, lib: { entry: path.join(owned.root, 'main.ts'), formats: ['es'] } },
    })).rejects.toThrow('Explicit image artifact directory does not exist');
  });

  it('keeps standalone builds independent of a missing image artifact directory', () => {
    vi.stubEnv('NAIDAN_STABLE_DIFFUSION_CORE_DIR', '/intentionally-missing-image-artifacts');
    const runtime = createStableDiffusionCppBrowserBuild({ rootDir: process.cwd(), mode: 'standalone' });
    expect(runtime.getNativeLicenseSource()).toBeUndefined();
  });
});
