// @vitest-environment node
import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createLicenseModulePlugins } from './license-module';
import { createLicenseCacheFixture, licenseCacheEntrySource } from './test-support/license-cache-fixture.test-support';
import { buildPWAFixture } from './test-support/pwa-fixture.test-support';
import { createWorkerHarness, MemoryCacheStorage, TestClients } from './test-support/pwa-worker-platform.test-support';

const scope = 'https://example.test/naidan/';

function findLicenseFile({ files, marker }: { files: ReadonlyMap<string, Buffer>, marker: string }): string {
  const matches = [...files].filter(([name, content]) => name.endsWith('.js') && content.toString().includes(marker));
  expect(matches).toHaveLength(1);
  return matches[0]![0];
}

describe('generated PWA cache reuse', () => {
  it('reuses unchanged assets across build identities while refreshing fixed-name files and real license payloads offline', async () => {
    await using fixture = await createLicenseCacheFixture();
    await fixture.prepare();
    // Tiny byte sentinels, NOT real Wasm/ZIP builds. Workbox treats them as
    // opaque responses, exactly as it treats the large production assets.
    const stable = new Map([
      ['runtime.wasm.gz', 'unchanged runtime bytes'],
      ['naidan-standalone.zip', 'unchanged archive bytes'],
      ['future-format.arbitrary', 'unchanged arbitrary bytes'],
    ]);
    const buildVersion = ({ buildId, mutable }: { buildId: string, mutable: string }) => buildPWAFixture({
      root: fixture.root,
      buildId,
      publicFiles: new Map([...stable, ['mutable.bin', mutable]]),
      entrySource: `console.info(__PWA_BUILD_ID__);\n${licenseCacheEntrySource}`,
      plugins: createLicenseModulePlugins({ getAdditionalDependencies: () => [] }),
    });
    const a = await buildVersion({ buildId: 'cache-version-a', mutable: 'mutable A' });
    await fs.writeFile(path.join(fixture.packageDirectory, 'LICENSE'), 'cache-probe license B\n');
    const b = await buildVersion({ buildId: 'cache-version-b', mutable: 'mutable B' });
    expect(a.pageBuildId).toBe('cache-version-a');
    expect(b.pageBuildId).toBe('cache-version-b');
    const licenseA = findLicenseFile({ files: a.files, marker: 'cache-probe license A' });
    const licenseB = findLicenseFile({ files: b.files, marker: 'cache-probe license B' });
    expect(licenseB).not.toBe(licenseA);
    for (const [name, content] of stable) {
      expect(a.files.get(name)?.toString()).toBe(content);
      expect(b.files.get(name)?.toString()).toBe(content);
    }

    const storage = new MemoryCacheStorage();
    const clients = new TestClients();
    clients.clients.set('page', { id: 'page', type: 'window', url: scope });
    const requested: string[] = [];
    let deployed = a;
    let offline = false;
    const network: typeof fetch = async input => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const name = url.pathname.slice(new URL(scope).pathname.length) || 'index.html';
      // Count attempts BEFORE throwing: offline fallback must not hide a miss.
      requested.push(name);
      if (offline) {
        throw new TypeError('offline');
      }
      const bytes = deployed.files.get(name);
      return new Response(bytes === undefined ? 'missing' : new Uint8Array(bytes), { status: bytes === undefined ? 404 : 200 });
    };
    const previous = createWorkerHarness({ script: a.script, scope, cacheStorage: storage, clients, fetch: network });
    await previous.lifecycle('install');
    await previous.lifecycle('activate');
    for (const name of [...stable.keys(), 'mutable.bin', licenseA]) {
      expect(requested.filter(item => item === name)).toHaveLength(1);
    }

    deployed = b;
    requested.length = 0;
    const next = createWorkerHarness({ script: b.script, scope, cacheStorage: storage, clients, fetch: network });
    await next.lifecycle('install');
    for (const name of stable.keys()) {
      expect(requested).not.toContain(name);
    }
    for (const name of ['mutable.bin', licenseB]) {
      expect(requested.filter(item => item === name)).toHaveLength(1);
    }
    expect(requested).not.toContain(licenseA);
    await next.lifecycle('activate');

    offline = true;
    requested.length = 0;
    for (const [name, content] of [...stable, ['mutable.bin', 'mutable B']]) {
      const response = await next.request({ url: `${scope}${name}` });
      expect(response.status).toBe(200);
      expect(await response.text()).toBe(content);
    }
    const licenseResponse = await next.request({ url: `${scope}${licenseB}` });
    expect(licenseResponse.status).toBe(200);
    expect(await licenseResponse.text()).toBe(b.files.get(licenseB)!.toString());
    const page = await next.request({ url: scope, navigation: true });
    expect(await page.text()).toContain('cache-version-b');
    expect(requested).toEqual([]);
  }, 60_000);
});
