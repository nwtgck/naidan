// @vitest-environment node
import os from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { resolveConfig, type EnvironmentModuleNode, type HotUpdateOptions, type ResolvedConfig, type ViteDevServer } from 'vite';
import { createPrivacyFetchBrokerDevPlugin } from './privacy-fetch-broker-dev';

describe('development plugin lifecycle', () => {
  let developmentConfig: ResolvedConfig;

  beforeAll(async () => {
    developmentConfig = await resolveConfig({ mode: 'development' }, 'serve');
  });

  it.each(['development', 'hosted'])('excludes output-mutating plugins from serve in %s mode', async (mode) => {
    const config = mode === 'development' ? developmentConfig : await resolveConfig({ mode }, 'serve');
    const names = config.plugins.map((plugin) => plugin.name);
    expect(names).toContain('privacy-fetch-broker-dev');
    expect(names).not.toContain('strip-privacy-fetch-broker-dev-injected-scripts');
    expect(names).not.toContain('manual-gzip-wasm-plugin');
    expect(names).not.toContain('copy-zip-plugin');
    expect(names.some((name) => name.startsWith('zip-packager-plugin-'))).toBe(false);
  });

  it('retains compression and standalone package copying in hosted builds', async () => {
    const config = await resolveConfig({ mode: 'hosted' }, 'build');
    const names = config.plugins.map((plugin) => plugin.name);
    expect(names).not.toContain('privacy-fetch-broker-dev');
    expect(names).toContain('manual-gzip-wasm-plugin');
    expect(names).toContain('copy-zip-plugin');
  });

  it('retains hosted archive creation in hosted builds', async () => {
    const config = await resolveConfig({ mode: 'hosted' }, 'build');
    expect(config.plugins.some((plugin) => plugin.name.startsWith('zip-packager-plugin-'))).toBe(true);
  });
});

// Real HTTP/HTML and watcher coverage lives in privacy-fetch-broker-dev.test.ts.
// Here, ensure the normal HMR pipeline cannot reload the parent ahead of a build.
function createDocumentHarness({ hmr, environmentName }: { hmr: boolean, environmentName: string }) {
  const root = path.join(os.tmpdir(), 'naidan-broker-hmr-hook-fixture');
  const hook = createPrivacyFetchBrokerDevPlugin().hotUpdate;
  const hotUpdate = typeof hook === 'function' ? hook : hook?.handler;
  if (hotUpdate === undefined) {
    throw new Error('Missing broker hotUpdate hook');
  }
  const send = vi.fn<(payload: unknown) => void>();
  const modules: EnvironmentModuleNode[] = [
    { id: path.join(root, 'broker.ts'), url: '/broker.ts' } as EnvironmentModuleNode,
  ];
  const server = { config: { root } } as unknown as ViteDevServer;
  const environment = { name: environmentName, config: { root, server: { hmr } }, hot: { send } };
  return {
    root,
    send,
    modules,
    async update({ type, file }: { type: HotUpdateOptions['type'], file: string }) {
      return hotUpdate.call({ environment } as never, { type, file, modules, server, timestamp: 1, read: () => '' });
    },
  };
}

describe('privacy fetch broker document updates', () => {
  it.each(['create', 'update', 'delete'] as const)('defers %s notifications to the completed auxiliary build', async type => {
    const fixture = createDocumentHarness({ hmr: true, environmentName: 'client' });
    const result = await fixture.update({ type, file: path.join(fixture.root, 'privacy-fetch-broker.html') });
    expect(result).toEqual([]);
    expect(fixture.send).not.toHaveBeenCalled();
  });

  it('leaves a different document with the same basename to Vite', async () => {
    const fixture = createDocumentHarness({ hmr: true, environmentName: 'client' });
    expect(await fixture.update({ type: 'update', file: path.join(fixture.root, 'nested/privacy-fetch-broker.html') })).toBe(fixture.modules);
    expect(fixture.send).not.toHaveBeenCalled();
  });

  it.each([
    { hmr: false, environmentName: 'client' },
    { hmr: true, environmentName: 'ssr' },
  ])('does not intercept updates for %j', async options => {
    const fixture = createDocumentHarness(options);
    expect(await fixture.update({ type: 'update', file: path.join(fixture.root, 'privacy-fetch-broker.html') })).toBe(fixture.modules);
    expect(fixture.send).not.toHaveBeenCalled();
  });
});
