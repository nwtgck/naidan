// @vitest-environment node
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'rolldown';
import { createLogger, loadConfigFromFile } from 'vite';
import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';

const supportsNativeTypeScript = process.features.typescript === 'strip' || process.features.typescript === 'transform';
const loadedConfigurationsSchema = z.array(z.object({
  mode: z.string(),
  command: z.enum(['serve', 'build']),
  warnings: z.array(z.string()),
  rootAlias: z.string(),
  outDir: z.string(),
  input: z.record(z.string(), z.string()),
  flags: z.object({
    standalone: z.enum(['true', 'false']),
    hosted: z.enum(['true', 'false']),
    test: z.enum(['true', 'false']),
  }),
}));

afterEach(() => vi.unstubAllEnvs());

async function loadConfigurations({ loader }: { loader: 'native' | 'bundle' }) {
  // This only loads the configuration and calls its factory. It never creates
  // an application builder, executes a build hook, or starts a browser/server.
  vi.stubEnv('VITE_CONFIG_NATIVE_IGNORE_WARNING', undefined);
  const configurations = [];
  for (const environment of [
    { command: 'serve', mode: 'development' },
    { command: 'serve', mode: 'test' },
    { command: 'build', mode: 'hosted' },
    { command: 'build', mode: 'standalone' },
  ] as const) {
    const warnings: string[] = [];
    const logger = createLogger('silent');
    logger.warn = message => warnings.push(message);
    logger.warnOnce = message => warnings.push(message);
    const loaded = await loadConfigFromFile(environment, undefined, process.cwd(), 'silent', logger, loader);
    if (!loaded || !Array.isArray(loaded.config.resolve?.alias)) {
      throw new Error('Expected an application config with array aliases for ' + environment.mode);
    }
    const config = loaded.config;
    configurations.push({
      ...environment,
      warnings,
      rootAlias: loaded.config.resolve.alias.find(alias => alias.find === '@')?.replacement,
      outDir: config.build?.outDir,
      input: config.build?.rollupOptions?.input,
      flags: {
        standalone: config.define?.__BUILD_MODE_IS_STANDALONE__,
        hosted: config.define?.__BUILD_MODE_IS_HOSTED__,
        test: config.define?.__BUILD_MODE_IS_TEST__,
      },
    });
  }
  return loadedConfigurationsSchema.parse(configurations);
}

function expectConfigurationModes({ loaded }: { loaded: z.infer<typeof loadedConfigurationsSchema> }): void {
  const root = process.cwd();
  const appInput = { app: resolve(root, 'index.html'), privacyFetchBroker: resolve(root, 'privacy-fetch-broker.html') };
  const standaloneInput = { index: resolve(root, 'index.html') };
  expect(loaded).toEqual([
    { mode: 'development', command: 'serve', warnings: [], rootAlias: resolve(root, 'src'), outDir: 'dist/hosted', input: appInput, flags: { standalone: 'false', hosted: 'true', test: 'false' } },
    { mode: 'test', command: 'serve', warnings: [], rootAlias: resolve(root, 'src'), outDir: 'dist/hosted', input: appInput, flags: { standalone: 'false', hosted: 'false', test: 'true' } },
    { mode: 'hosted', command: 'build', warnings: [], rootAlias: resolve(root, 'src'), outDir: 'dist/hosted', input: appInput, flags: { standalone: 'false', hosted: 'true', test: 'false' } },
    { mode: 'standalone', command: 'build', warnings: [], rootAlias: resolve(root, 'src'), outDir: 'dist/standalone', input: standaloneInput, flags: { standalone: 'true', hosted: 'false', test: 'false' } },
  ]);
}

function incompatibleConfiguration({ source }: { source: string }) {
  const directory = mkdtempSync(join(tmpdir(), 'naidan-vite-native-config-'));
  const filename = join(directory, 'vite.config.mjs');
  writeFileSync(join(directory, 'package.json'), JSON.stringify({ type: 'module' }));
  writeFileSync(filename, source);
  writeFileSync(join(directory, 'entry.js'), "export const fixtureBase = 'fixture/';\n");
  return {
    directory,
    filename,
    [Symbol.dispose]() {
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

it('bundles Vite configuration dependencies without application-only path aliases', async () => {
  // Vite bundles its configuration before installing resolve.alias. A bare
  // @/ import in this graph becomes an external package at Node startup.
  const { output } = await build({
    input: resolve(process.cwd(), 'vite.config.ts'),
    platform: 'node',
    external: id => !id.startsWith('.') && !id.startsWith('/') && !id.startsWith('node:'),
    output: { format: 'esm' },
    write: false,
  });
  const configImports = output.flatMap(file => file.type === 'chunk' ? file.imports : []);
  expect(configImports.filter(id => id.startsWith('@/'))).toEqual([]);
});

// Native .ts loading requires Node's type stripping to be enabled.
it.skipIf(!supportsNativeTypeScript)('loads the real Vite config through the native loader in every application mode', async () => {
  expectConfigurationModes({ loaded: await loadConfigurations({ loader: 'native' }) });
}, 30_000);

it('loads the real Vite config without native-compatibility warnings through the bundle loader', async () => {
  expectConfigurationModes({ loaded: await loadConfigurations({ loader: 'bundle' }) });
}, 30_000);

it.each([
  {
    name: 'CommonJS dirname',
    source: `\
export default { base: __dirname };
`,
    warning: '__dirname',
    failure: /__dirname/,
  },
  {
    name: 'extensionless imports',
    source: `\
import { fixtureBase } from './entry';
export default { base: fixtureBase };
`,
    warning: 'without a file extension',
    failure: /Cannot find module/,
  },
])('keeps native incompatibility visible for $name', async ({ source, warning, failure }) => {
  using fixture = incompatibleConfiguration({ source });
  vi.stubEnv('VITE_CONFIG_NATIVE_IGNORE_WARNING', undefined);
  const warnings: string[] = [];
  const logger = createLogger('silent');
  logger.warn = message => warnings.push(message);
  // A bundled positive control proves these are otherwise valid config files.
  const bundled = await loadConfigFromFile({ command: 'serve', mode: 'test' }, fixture.filename, fixture.directory, 'silent', logger, 'bundle');
  expect(bundled?.config.base).toBeTruthy();
  expect(warnings.join('\n')).toContain(warning);
  // Vite's native import path must reject the same source instead of allowing
  // Vitest's TypeScript transform to hide the unsupported Node ESM syntax.
  await expect(loadConfigFromFile({ command: 'serve', mode: 'test' }, fixture.filename, fixture.directory, 'silent', createLogger('silent'), 'native')).rejects.toThrow(failure);
});
