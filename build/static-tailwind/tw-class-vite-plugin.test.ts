import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertCssRegistrationBundleIntegrity, createTwClassVitePlugin } from './tw-class-vite-plugin';

const temporaryDirectories: string[] = [];

type HookHandler<TArguments extends unknown[], TResult> = (...arguments_: TArguments) => TResult;

function getHookHandler<TArguments extends unknown[], TResult>({ hook, name }: {
  hook: unknown,
  name: string,
}): HookHandler<TArguments, TResult> {
  if (typeof hook === 'function') {
    return hook as HookHandler<TArguments, TResult>;
  }
  if (typeof hook === 'object' && hook !== null && 'handler' in hook && typeof hook.handler === 'function') {
    return hook.handler as HookHandler<TArguments, TResult>;
  }
  throw new TypeError(`Expected ${name} to be a callable Vite hook.`);
}

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function writeFile({ root, relativePath, content }: {
  root: string,
  relativePath: string,
  content: string,
}): void {
  const filename = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, content);
}

function createFixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'naidan-static-tailwind-hmr-'));
  temporaryDirectories.push(root);
  fs.symlinkSync(path.resolve(import.meta.dirname, '../../node_modules'), path.join(root, 'node_modules'), 'dir');
  writeFile({
    root,
    relativePath: 'package.json',
    content: JSON.stringify({ devDependencies: { tailwindcss: '4.3.2' } }),
  });
  writeFile({ root, relativePath: 'src/style.css', content: '@import "tailwindcss" source(none);\n' });
  writeFile({
    root,
    relativePath: 'src/main.ts',
    content: `export const loadA = () => import('./FeatureA.vue');\nexport const loadB = () => import('./FeatureB.vue');\n`,
  });
  writeFile({ root, relativePath: 'src/FeatureA.vue', content: '<template><div tw-class="p-2">A</div></template>\n' });
  writeFile({ root, relativePath: 'src/FeatureB.vue', content: '<template><div tw-class="text-blue-500">B</div></template>\n' });
  return root;
}

async function createServeHarness({ root }: { root: string }) {
  const sourceRoot = path.join(root, 'src');
  const plugin = createTwClassVitePlugin({
    projectRoot: root,
    sourceRoot,
    entryModule: path.join(sourceRoot, 'main.ts'),
    tailwindCssPath: path.join(sourceRoot, 'style.css'),
    debugOutputDirectory: undefined,
    outputMode: 'split',
    cssPlanning: 'enabled',
    maxSplitCssGroups: undefined,
  });
  const configResolved = getHookHandler<[unknown], void | Promise<void>>({
    hook: plugin.configResolved,
    name: 'configResolved',
  });
  await configResolved.call({} as never, { command: 'serve' });
  const buildStart = getHookHandler<[unknown], void | Promise<void>>({
    hook: plugin.buildStart,
    name: 'buildStart',
  });
  await buildStart.call({ info() {} } as never, {});
  const hotUpdate = getHookHandler<[unknown], unknown | Promise<unknown>>({
    hook: plugin.hotUpdate,
    name: 'hotUpdate',
  });
  return { hotUpdate, plugin, sourceRoot };
}

function createHotUpdateContext({ environmentName, reloads, sentPayloads, onSend }: {
  environmentName: string;
  reloads: unknown[];
  sentPayloads: unknown[];
  onSend: (() => void) | undefined;
}) {
  return {
    environment: {
      name: environmentName,
      moduleGraph: {
        getModuleById() {
          return undefined;
        },
        getModulesByFile() {
          return undefined;
        },
      },
      async reloadModule(module: unknown) {
        reloads.push(module);
      },
      hot: {
        send(payload: unknown) {
          sentPayloads.push(payload);
          onSend?.();
        },
      },
    },
  };
}

describe('static Tailwind Vite plugin configuration', () => {
  function optionsForRoot({ root }: { root: string }) {
    const sourceRoot = path.join(root, 'src');
    return {
      projectRoot: root,
      sourceRoot,
      entryModule: path.join(sourceRoot, 'main.ts'),
      tailwindCssPath: path.join(sourceRoot, 'style.css'),
      debugOutputDirectory: undefined,
      outputMode: 'split' as const,
      cssPlanning: 'enabled' as const,
      maxSplitCssGroups: undefined,
    };
  }

  it('rejects unknown planning modes and invalid group limits immediately', () => {
    const root = createFixture();
    const options = optionsForRoot({ root });
    expect(() => createTwClassVitePlugin({
      ...options,
      cssPlanning: 'unexpected' as 'enabled',
    })).toThrow(/Unknown CSS planning mode/u);
    expect(() => createTwClassVitePlugin({
      ...options,
      maxSplitCssGroups: 1.5,
    })).toThrow(/maxSplitCssGroups must be a non-negative integer/u);
  });

  it('rejects destructive debug output directories before buildStart can clear them', () => {
    const root = createFixture();
    const options = optionsForRoot({ root });
    expect(() => createTwClassVitePlugin({
      ...options,
      debugOutputDirectory: root,
    })).toThrow(/dedicated child directory under a projectRoot\/dist/u);
    expect(() => createTwClassVitePlugin({
      ...options,
      debugOutputDirectory: path.join(root, 'src', 'debug-tailwind'),
    })).toThrow(/dedicated child directory under a projectRoot\/dist/u);
    expect(() => createTwClassVitePlugin({
      ...options,
      debugOutputDirectory: path.join(root, 'dist'),
    })).toThrow(/dedicated child directory under a projectRoot\/dist/u);
    expect(() => createTwClassVitePlugin({
      ...options,
      debugOutputDirectory: path.join(path.dirname(root), 'outside-debug-tailwind'),
    })).toThrow(/dedicated child directory under a projectRoot\/dist/u);
    const outsideDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'naidan-static-tailwind-debug-outside-'));
    temporaryDirectories.push(outsideDirectory);
    const linkedDist = path.join(root, 'dist-linked');
    fs.symlinkSync(
      outsideDirectory,
      linkedDist,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    expect(() => createTwClassVitePlugin({
      ...options,
      debugOutputDirectory: path.join(linkedDist, 'debug-tailwind'),
    })).toThrow(/must not traverse symbolic links/u);
    expect(() => createTwClassVitePlugin({
      ...options,
      debugOutputDirectory: path.join(root, 'dist', 'debug-tailwind'),
    })).not.toThrow();
  });

  it('fails fast when required source paths are missing or have the wrong type', () => {
    const root = createFixture();
    const options = optionsForRoot({ root });
    expect(() => createTwClassVitePlugin({
      ...options,
      sourceRoot: path.join(root, 'missing-source'),
    })).toThrow(/sourceRoot does not exist/u);
    expect(() => createTwClassVitePlugin({
      ...options,
      entryModule: path.join(root, 'src'),
    })).toThrow(/entryModule must be a file/u);
    expect(() => createTwClassVitePlugin({
      ...options,
      tailwindCssPath: path.join(root, 'missing.css'),
    })).toThrow(/tailwindCssPath does not exist/u);
  });
});

describe('static Tailwind Vite plugin owner registration', () => {
  it('shares one registration when an owner filename contains the previous delimiter character', async () => {
    const root = createFixture();
    const sourceRoot = path.join(root, 'src');
    const pipeFeature = path.join(sourceRoot, 'Feature|A.vue');
    fs.renameSync(path.join(sourceRoot, 'FeatureA.vue'), pipeFeature);
    fs.writeFileSync(
      path.join(sourceRoot, 'main.ts'),
      `export const loadA = () => import('./Feature|A.vue');
export const loadB = () => import('./FeatureB.vue');
`,
    );
    fs.writeFileSync(
      path.join(sourceRoot, 'FeatureB.vue'),
      '<template><div tw-class="p-2">B</div></template>\n',
    );
    const plugin = createTwClassVitePlugin({
      projectRoot: root,
      sourceRoot,
      entryModule: path.join(sourceRoot, 'main.ts'),
      tailwindCssPath: path.join(sourceRoot, 'style.css'),
      debugOutputDirectory: undefined,
      outputMode: 'split',
      cssPlanning: 'enabled',
      maxSplitCssGroups: undefined,
    });
    const configResolved = getHookHandler<[unknown], void | Promise<void>>({
      hook: plugin.configResolved,
      name: 'configResolved',
    });
    await configResolved.call({} as never, { command: 'build' });
    const buildStart = getHookHandler<[unknown], void | Promise<void>>({
      hook: plugin.buildStart,
      name: 'buildStart',
    });
    await buildStart.call({ info() {} } as never, {});

    const imports = plugin.api.getImportsByModule();
    const pipeImports = imports.get(pipeFeature) ?? [];
    const otherImports = imports.get(path.join(sourceRoot, 'FeatureB.vue')) ?? [];
    expect(pipeImports).toHaveLength(1);
    expect(otherImports).toEqual(pipeImports);
    expect(pipeImports[0]).toMatch(/^virtual:naidan-tailwind-css-module\/[a-f0-9]{64}\.js$/u);
  });
});

describe('static Tailwind Vite plugin source transform gating', () => {
  it('rejects macro use outside the production source-analysis boundary', async () => {
    const root = createFixture();
    const sourceRoot = path.join(root, 'src');
    const plugin = createTwClassVitePlugin({
      projectRoot: root,
      sourceRoot,
      entryModule: path.join(sourceRoot, 'main.ts'),
      tailwindCssPath: path.join(sourceRoot, 'style.css'),
      debugOutputDirectory: undefined,
      outputMode: 'split',
      cssPlanning: 'enabled',
      maxSplitCssGroups: undefined,
    });
    const transform = getHookHandler<[string, string], unknown | Promise<unknown>>({
      hook: plugin.transform,
      name: 'transform',
    });
    const macroSource = `import { tw } from 'virtual:naidan-tailwind'; tw('p-2');`;

    expect(() => transform.call({} as never, macroSource, path.join(root, 'shared.ts')))
      .toThrow(/only supported in production source files covered by static analysis/u);
    expect(() => transform.call({} as never, macroSource, path.join(sourceRoot, 'Ignored.test.ts')))
      .toThrow(/only supported in production source files covered by static analysis/u);
    expect(() => transform.call(
      {} as never,
      '<template><div tw-class="p-2" /></template>',
      path.join(root, 'Outside.vue'),
    )).toThrow(/Vue Tailwind attributes are only supported in production source files covered by static analysis/u);
    expect(() => transform.call(
      {} as never,
      '<template><div tw-class="p-2" /></template>',
      path.join(sourceRoot, 'Ignored.test.vue'),
    )).toThrow(/Vue Tailwind attributes are only supported in production source files covered by static analysis/u);
    expect(transform.call(
      {} as never,
      `const fixtureValue = 'virtual:naidan-tailwind';`,
      path.join(root, 'fixture-data.ts'),
    )).toBeNull();
    expect(transform.call(
      {} as never,
      '<template><div>tw-class is only text here</div></template>',
      path.join(root, 'fixture-data.vue'),
    )).toBeNull();
  });

  it('does not parse unrelated modules that have no macro or CSS registration imports', async () => {
    const root = createFixture();
    const sourceRoot = path.join(root, 'src');
    const plugin = createTwClassVitePlugin({
      projectRoot: root,
      sourceRoot,
      entryModule: path.join(sourceRoot, 'main.ts'),
      tailwindCssPath: path.join(sourceRoot, 'style.css'),
      debugOutputDirectory: undefined,
      outputMode: 'split',
      cssPlanning: 'disabled',
      maxSplitCssGroups: undefined,
    });
    const transform = getHookHandler<[string, string], unknown | Promise<unknown>>({
      hook: plugin.transform,
      name: 'transform',
    });

    expect(transform.call({} as never, 'const deliberatelyInvalid = <;', path.join(sourceRoot, 'Unrelated.ts'))).toBeNull();
  });

  it('parses JavaScript JSX and TypeScript TSX modules with their matching syntax', async () => {
    const root = createFixture();
    const sourceRoot = path.join(root, 'src');
    const plugin = createTwClassVitePlugin({
      projectRoot: root,
      sourceRoot,
      entryModule: path.join(sourceRoot, 'main.ts'),
      tailwindCssPath: path.join(sourceRoot, 'style.css'),
      debugOutputDirectory: undefined,
      outputMode: 'split',
      cssPlanning: 'disabled',
      maxSplitCssGroups: undefined,
    });
    const transform = getHookHandler<[string, string], unknown | Promise<unknown>>({
      hook: plugin.transform,
      name: 'transform',
    });
    const fixtures = [
      {
        filename: path.join(sourceRoot, 'View.jsx'),
        source: `import { tw } from 'virtual:naidan-tailwind';\nexport const view = <div className={tw('p-2')} />;\n`,
        candidate: 'p-2',
      },
      {
        filename: path.join(sourceRoot, 'View.tsx'),
        source: `import { tw } from 'virtual:naidan-tailwind';\nexport const view: JSX.Element = <div className={tw('p-4')} />;\n`,
        candidate: 'p-4',
      },
    ];

    for (const fixture of fixtures) {
      const result = await transform.call({} as never, fixture.source, fixture.filename) as {
        code: string,
      };
      expect(result.code).toContain(JSON.stringify(fixture.candidate));
      expect(result.code).toContain('<div className=');
      expect(result.code).not.toContain('virtual:naidan-tailwind');
    }
  });
});

describe('static Tailwind Boundary Strings payload boundary', () => {
  async function createPayloadTransformHarness({ root, command, cssPlanning }: { root: string; command: 'serve' | 'build'; cssPlanning: 'enabled' | 'disabled' }) {
    const sourceRoot = path.join(root, 'src');
    const plugin = createTwClassVitePlugin({
      projectRoot: root,
      sourceRoot,
      entryModule: path.join(sourceRoot, 'main.ts'),
      tailwindCssPath: path.join(sourceRoot, 'style.css'),
      debugOutputDirectory: undefined,
      outputMode: 'split',
      cssPlanning,
      maxSplitCssGroups: undefined,
    });
    const configResolved = getHookHandler<[unknown], void | Promise<void>>({ hook: plugin.configResolved, name: 'configResolved' });
    await configResolved.call({} as never, { command });
    const transform = getHookHandler<[string, string], unknown>({ hook: plugin.transform, name: 'transform' });
    return { sourceRoot, transform };
  }

  it.each(['serve', 'build'] as const)('rejects supported payload macro imports through the shared %s compiler', async (command) => {
    const root = createFixture();
    const { sourceRoot, transform } = await createPayloadTransformHarness({ root, command, cssPlanning: 'enabled' });
    const sources = [
      `import { tw } from 'virtual:naidan-tailwind'; export const message = tw('p-2');`,
      `import { tw as utility } from 'virtual:naidan-tailwind'; export const message = utility('p-2');`,
      `import { twClassString } from 'virtual:naidan-tailwind'; export const message = twClassString('p-2', 'm-1');`,
      `import { tw } from 'virtual:naidan-tailwind'; export const message = 'unused macro';`,
    ];
    for (const payload of ['messages', 'catalogs']) {
      for (const extension of ['ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs']) {
        const filename = path.join(sourceRoot, 'strings', payload, `message.${extension}`);
        for (const source of sources) {
          expect(() => transform.call({} as never, source, filename))
            .toThrow(/Compile-time Tailwind macros are only supported in production source files covered by static analysis/u);
        }
      }
      for (const extension of ['ts', 'tsx', 'mts', 'cts']) {
        for (const source of [
          `import type { TailwindClass } from 'virtual:naidan-tailwind'; export type MessageClass = TailwindClass;`,
          `import { type TailwindClassValue } from 'virtual:naidan-tailwind'; export type MessageClass = TailwindClassValue;`,
        ]) {
          expect(() => transform.call({} as never, source, path.join(sourceRoot, 'strings', payload, `message.${extension}`)))
            .toThrow(/Compile-time Tailwind macros are only supported in production source files covered by static analysis/u);
        }
      }
    }
  });

  it.each(['serve', 'build'] as const)('preserves unsupported macro diagnostics and ordinary payload text in %s', async (command) => {
    const root = createFixture();
    const { sourceRoot, transform } = await createPayloadTransformHarness({ root, command, cssPlanning: 'enabled' });
    const unsupported = [
      { source: `export { tw } from 'virtual:naidan-tailwind';`, error: /may not be re-exported/u },
      { source: `import * as macros from 'virtual:naidan-tailwind';`, error: /only supports named imports/u },
      { source: `import macros from 'virtual:naidan-tailwind';`, error: /only supports named imports/u },
      { source: `import 'virtual:naidan-tailwind';`, error: /only supports named imports/u },
      { source: `const macros = require('virtual:naidan-tailwind');`, error: /may not be loaded with require/u },
      { source: `const macros = import('virtual:naidan-tailwind');`, error: /may not be dynamically imported/u },
      { source: `import macros = require('virtual:naidan-tailwind');`, error: /only supports named ES module imports/u },
      { source: `import { tw } from 'virtual:naidan-tailwind'; tw(dynamicValue);`, error: /requires exactly one string literal/u },
    ];
    const ordinary = `\
// import { tw } from 'virtual:naidan-tailwind'; tw('p-2');
export const message = 'virtual:naidan-tailwind, tw-class and tw() are ordinary text here.';
`;
    for (const payload of ['messages', 'catalogs']) {
      const filename = path.join(sourceRoot, 'strings', payload, 'message.ts');
      for (const { source, error } of unsupported) {
        expect(() => transform.call({} as never, source, filename)).toThrow(error);
      }
      expect(transform.call({} as never, ordinary, filename)).toBeNull();
      expect(() => transform.call({} as never, `import { tw } from 'virtual:naidan-tailwind'; tw('p-2');`, filename))
        .toThrow(/covered by static analysis/u);
      expect(transform.call({} as never, `export const message = 'corrected message';`, filename)).toBeNull();
    }
  });

  it.each(['serve', 'build'] as const)('rejects payload Vue files before parsing raw or query source in %s', async (command) => {
    const root = createFixture();
    const { sourceRoot, transform } = await createPayloadTransformHarness({ root, command, cssPlanning: 'enabled' });
    for (const payload of ['messages', 'catalogs']) {
      const filename = path.join(sourceRoot, 'strings', payload, 'Message.vue');
      for (const { source, query } of [
        { source: '<template><div tw-class="p-2" /></template>', query: '' },
        { source: '<template><div>plain message</div></template>', query: '' },
        { source: '<template src="./Message.html"></template>', query: '' },
        { source: '<template lang="pug">div.p-2</template>', query: '' },
        { source: 'This query must not be parsed as a module.', query: '?vue&type=script&lang.ts' },
        { source: 'This query must not be parsed as a template.', query: '?vue&type=template&id=message' },
        { source: 'raw payload source', query: '?raw' },
      ]) {
        expect(() => transform.call({} as never, source, `${filename}${query}`))
          .toThrow(/Vue files are not supported in Boundary Strings message and catalog payloads/u);
      }
    }
    expect(transform.call({} as never, '<template><div>tw-class is text</div></template>', path.join(root, 'Outside.vue'))).toBeNull();
    expect(transform.call({} as never, 'query without macros', path.join(root, 'Outside.vue?vue&type=script'))).toBeNull();
  });

  it.each(['serve', 'build'] as const)('enforces the payload boundary inside nested node_modules in %s', async (command) => {
    const root = createFixture();
    const { sourceRoot, transform } = await createPayloadTransformHarness({ root, command, cssPlanning: 'enabled' });
    const macro = `import { tw } from 'virtual:naidan-tailwind'; export const message = tw('p-2');`;
    const ordinary = `export const message = 'virtual:naidan-tailwind and tw-class are ordinary text';`;
    for (const payload of ['messages', 'catalogs']) {
      const directory = path.join(sourceRoot, 'strings', payload, 'node_modules');
      const filename = path.join(directory, 'message.ts');
      expect(() => transform.call({} as never, macro, filename)).toThrow(/covered by static analysis/u);
      expect(() => transform.call({} as never, `import * as macros from 'virtual:naidan-tailwind';`, filename))
        .toThrow(/only supports named imports/u);
      expect(transform.call({} as never, ordinary, filename)).toBeNull();
      for (const query of ['', '?vue&type=script&lang.ts', '?vue&type=template&id=message']) {
        expect(() => transform.call(
          {} as never,
          '<template><div tw-class="p-2" /></template>',
          `${path.join(directory, 'Message.vue')}${query}`,
        )).toThrow(/Vue files are not supported in Boundary Strings message and catalog payloads/u);
      }
    }
    expect(transform.call({} as never, macro, path.join(root, 'node_modules/vendor/message.ts'))).toBeNull();
    expect(transform.call({} as never, '<template><div tw-class="p-2" /></template>', path.join(root, 'node_modules/vendor/Component.vue'))).toBeNull();
  });

  it('keeps the existing disabled-planning transform behavior', async () => {
    const root = createFixture();
    const { sourceRoot, transform } = await createPayloadTransformHarness({ root, command: 'serve', cssPlanning: 'disabled' });
    expect(transform.call({} as never, '<template><div>message</div></template>', path.join(sourceRoot, 'strings/messages/Message.vue'))).toBeNull();
    expect(transform.call(
      {} as never,
      `import { tw } from 'virtual:naidan-tailwind'; export const message = tw('p-2');`,
      path.join(sourceRoot, 'strings/messages/message.ts'),
    )).toEqual(expect.objectContaining({ code: expect.stringContaining('"p-2"') }));
    expect(transform.call(
      {} as never,
      `import { tw } from 'virtual:naidan-tailwind'; export const message = tw('p-2');`,
      path.join(sourceRoot, 'strings/catalogs/node_modules/message.ts'),
    )).toBeNull();
    for (const query of ['', '?vue&type=script&lang.ts', '?vue&type=template&id=message']) {
      expect(transform.call(
        {} as never,
        '<template><div tw-class="p-2" /></template>',
        `${path.join(sourceRoot, 'strings/messages/node_modules/Message.vue')}${query}`,
      )).toBeNull();
    }
  });

  it.each(['messages', 'catalogs'])('passes %s source events through HMR without requesting a Tailwind plan', async (payload) => {
    const root = createFixture();
    const filename = path.join(root, 'src', 'strings', payload, 'message.ts');
    writeFile({ root, relativePath: path.relative(root, filename), content: `export const message = 'hello';` });
    const { hotUpdate, plugin } = await createServeHarness({ root });
    const initialPlan = plugin.api.getPlan();
    const context = createHotUpdateContext({ environmentName: 'client', reloads: [], sentPayloads: [], onSend: undefined });
    const modules = [{ id: filename }];
    for (const event of ['update', 'create', 'delete'] as const) {
      let file: string;
      switch (event) {
      case 'update':
        file = filename;
        fs.writeFileSync(file, `export const message = 'updated';`);
        break;
      case 'create':
        file = path.join(path.dirname(filename), 'created.ts');
        fs.writeFileSync(file, `export const message = 'created';`);
        break;
      case 'delete':
        file = filename;
        fs.rmSync(file);
        break;
      default: {
        const _ex: never = event;
        throw new Error(`Unhandled payload event: ${String(_ex)}`);
      }
      }
      expect(await hotUpdate.call(context as never, { file, type: event, modules })).toBe(modules);
      expect(plugin.api.getPlan()).toBe(initialPlan);
    }
  });

  it('adds and retires owners when a source moves across the payload boundary', async () => {
    const root = createFixture();
    const source = path.join(root, 'src', 'Movable.ts');
    const payload = path.join(root, 'src', 'strings', 'messages', 'message.ts');
    fs.mkdirSync(path.dirname(payload), { recursive: true });
    fs.writeFileSync(source, `import { tw } from 'virtual:naidan-tailwind'; export const value = tw('p-8');`);
    const { hotUpdate, plugin } = await createServeHarness({ root });
    const transform = getHookHandler<[string, string], unknown>({ hook: plugin.transform, name: 'transform' });
    const context = createHotUpdateContext({ environmentName: 'client', reloads: [], sentPayloads: [], onSend: undefined });
    expect(plugin.api.getImportsByModule().has(source)).toBe(true);

    fs.renameSync(source, payload);
    await Promise.all([
      hotUpdate.call(context as never, { file: source, type: 'delete', modules: [] }),
      hotUpdate.call(context as never, { file: payload, type: 'create', modules: [] }),
    ]);
    expect(plugin.api.getPlan()?.candidates).not.toContain('p-8');
    expect(plugin.api.getImportsByModule().has(source)).toBe(false);
    expect(() => transform.call({} as never, fs.readFileSync(payload, 'utf8'), payload)).toThrow(/covered by static analysis/u);
    fs.writeFileSync(payload, `export const message = 'corrected';`);
    expect(transform.call({} as never, fs.readFileSync(payload, 'utf8'), payload)).toBeNull();

    const renamed = path.join(root, 'src', 'Renamed.ts');
    fs.writeFileSync(payload, `import { tw } from 'virtual:naidan-tailwind'; export const value = tw('p-16');`);
    fs.renameSync(payload, renamed);
    await Promise.all([
      hotUpdate.call(context as never, { file: payload, type: 'delete', modules: [] }),
      hotUpdate.call(context as never, { file: renamed, type: 'create', modules: [] }),
    ]);
    expect(plugin.api.getPlan()?.candidates).toContain('p-16');
    expect(plugin.api.getImportsByModule().has(renamed)).toBe(true);
  });

  it.each(['messages', 'catalogs'])('preserves explicitly imported %s CSS updates and failed-delivery restoration', async (payload) => {
    const root = createFixture();
    const theme = path.join(root, 'src', 'strings', payload, 'theme.css');
    const red = '.payload-css-marker { color: red; }';
    writeFile({ root, relativePath: path.relative(root, theme), content: red });
    fs.appendFileSync(path.join(root, 'src/style.css'), `@import "./strings/${payload}/theme.css";`);
    const { hotUpdate, plugin } = await createServeHarness({ root });
    expect(plugin.api.getPlan()?.stylesheetDependencies).toContain(theme);
    expect(plugin.api.getPlan()?.baselineCss).toContain('color: red');
    let failDelivery = true;
    const delivered: string[] = [];
    const load = getHookHandler<[string], string>({ hook: plugin.load, name: 'load' });
    const context = {
      environment: {
        name: 'client',
        moduleGraph: {
          getModuleById(id: string) {
            return { id };
          },
          getModulesByFile() {
            return undefined;
          },
        },
        async reloadModule({ id }: { id: string }) {
          delivered.push(load.call({} as never, id));
          if (failDelivery) {
            throw new Error('interrupted payload CSS delivery');
          }
        },
        hot: { send() {} },
      },
    };
    fs.writeFileSync(theme, red.replace('color: red', 'color: blue'));
    await expect(hotUpdate.call(context as never, { file: theme, timestamp: 5200, modules: [] }))
      .rejects.toThrow('interrupted payload CSS delivery');
    expect(plugin.api.getPlan()?.baselineCss).toContain('color: blue');
    const failedDeliveries = delivered.length;

    failDelivery = false;
    fs.writeFileSync(theme, red);
    await hotUpdate.call(context as never, { file: theme, timestamp: 5201, modules: [] });
    expect(plugin.api.getPlan()?.stylesheetDependencies).toContain(theme);
    expect(plugin.api.getPlan()?.baselineCss).toContain('color: red');
    expect(plugin.api.getPlan()?.baselineCss).not.toContain('color: blue');
    expect(delivered.length).toBeGreaterThan(failedDeliveries);
    expect(delivered.at(-1)).toContain('color: red');
  });
});

describe('static Tailwind Vite plugin build diagnostics', () => {
  it('replaces stale debug output with the current analysis and ownership plan', async () => {
    const root = createFixture();
    const sourceRoot = path.join(root, 'src');
    const debugOutputDirectory = path.join(root, 'dist/debug-tailwind');
    const staleFile = path.join(debugOutputDirectory, 'stale.json');
    fs.mkdirSync(debugOutputDirectory, { recursive: true });
    fs.writeFileSync(staleFile, '{}\n');
    const plugin = createTwClassVitePlugin({
      projectRoot: root,
      sourceRoot,
      entryModule: path.join(sourceRoot, 'main.ts'),
      tailwindCssPath: path.join(sourceRoot, 'style.css'),
      debugOutputDirectory,
      outputMode: 'single',
      cssPlanning: 'enabled',
      maxSplitCssGroups: undefined,
    });
    const configResolved = getHookHandler<[unknown], void | Promise<void>>({
      hook: plugin.configResolved,
      name: 'configResolved',
    });
    await configResolved.call({} as never, { command: 'build' });
    const buildStart = getHookHandler<[unknown], void | Promise<void>>({
      hook: plugin.buildStart,
      name: 'buildStart',
    });
    await buildStart.call({ info() {} } as never, {});

    expect(fs.existsSync(staleFile)).toBe(false);
    const writeBundle = getHookHandler<[], void | Promise<void>>({
      hook: plugin.writeBundle,
      name: 'writeBundle',
    });
    await writeBundle.call({} as never);
    const sourceAnalysis = JSON.parse(fs.readFileSync(
      path.join(debugOutputDirectory, 'source-analysis.json'),
      'utf8',
    )) as { candidateOwners: Record<string, string[]> };
    const ownershipPlan = JSON.parse(fs.readFileSync(
      path.join(debugOutputDirectory, 'ownership-plan.json'),
      'utf8',
    )) as { candidates: string[] };
    const groupManifest = JSON.parse(fs.readFileSync(
      path.join(debugOutputDirectory, 'css-groups/groups.json'),
      'utf8',
    )) as { groups: Record<string, unknown> };
    expect(sourceAnalysis.candidateOwners).toHaveProperty('p-2');
    expect(ownershipPlan.candidates).toContain('text-blue-500');
    expect(Object.keys(groupManifest.groups).length).toBeGreaterThan(0);
  });
});

describe('static Tailwind Vite plugin HMR ownership', () => {
  it('retires the private CSS module when a candidate becomes shared', async () => {
    const root = createFixture();
    const sourceRoot = path.join(root, 'src');
    const plugin = createTwClassVitePlugin({
      projectRoot: root,
      sourceRoot,
      entryModule: path.join(sourceRoot, 'main.ts'),
      tailwindCssPath: path.join(sourceRoot, 'style.css'),
      debugOutputDirectory: path.join(root, 'dist/debug-tailwind'),
      outputMode: 'split',
      cssPlanning: 'enabled',
      maxSplitCssGroups: undefined,
    });
    const configResolved = getHookHandler<[unknown], void | Promise<void>>({
      hook: plugin.configResolved,
      name: 'configResolved',
    });
    await configResolved.call({} as never, { command: 'serve' });
    const buildStart = getHookHandler<[unknown], void | Promise<void>>({
      hook: plugin.buildStart,
      name: 'buildStart',
    });
    await buildStart.call({ info() {} } as never, {});

    const featureA = path.join(sourceRoot, 'FeatureA.vue');
    const featureB = path.join(sourceRoot, 'FeatureB.vue');
    const beforeImports = plugin.api.getImportsByModule();
    const beforeA = beforeImports.get(featureA) ?? [];
    const beforeB = beforeImports.get(featureB) ?? [];
    const privateA = beforeA.find((id) => !beforeB.includes(id));
    expect(privateA).toBeDefined();
    if (privateA === undefined) {
      throw new TypeError('Expected Feature A to own a private CSS module before the update.');
    }

    fs.writeFileSync(featureB, '<template><div tw-class="text-blue-500"><span tw-class="p-2">B</span></div></template>\n');
    const reloads: unknown[] = [];
    const customMessages: unknown[] = [];
    const context = {
      environment: {
        name: 'client',
        moduleGraph: {
          getModuleById(id: string) {
            return { id };
          },
          getModulesByFile(filename: string) {
            return new Set([{ id: filename }]);
          },
        },
        async reloadModule(module: unknown) {
          reloads.push(module);
        },
        hot: {
          send(message: unknown) {
            customMessages.push(message);
          },
        },
      },
    };
    const hotUpdate = getHookHandler<[unknown], unknown | Promise<unknown>>({
      hook: plugin.hotUpdate,
      name: 'hotUpdate',
    });
    await hotUpdate.call(context as never, {
      file: featureB,
      timestamp: Date.now(),
      modules: [],
    });

    const afterImports = plugin.api.getImportsByModule();
    const shared = (afterImports.get(featureA) ?? []).filter((id) => (afterImports.get(featureB) ?? []).includes(id));
    expect(shared.length).toBeGreaterThan(0);
    expect(shared).not.toContain(privateA);
    expect(customMessages).toContainEqual({
      type: 'custom',
      event: 'naidan-tailwind:retire-css',
      data: { moduleIds: expect.arrayContaining([`\0${privateA}`]) },
    });
    expect(reloads.length).toBeGreaterThan(0);
  });

  it('retires shared and private registrations as ownership shrinks and disappears', async () => {
    const root = createFixture();
    const sourceRoot = path.join(root, 'src');
    const featureA = path.join(sourceRoot, 'FeatureA.vue');
    const featureB = path.join(sourceRoot, 'FeatureB.vue');
    fs.writeFileSync(featureB, '<template><div tw-class="text-blue-500 p-2">B</div></template>\n');

    const plugin = createTwClassVitePlugin({
      projectRoot: root,
      sourceRoot,
      entryModule: path.join(sourceRoot, 'main.ts'),
      tailwindCssPath: path.join(sourceRoot, 'style.css'),
      debugOutputDirectory: path.join(root, 'dist/debug-tailwind'),
      outputMode: 'split',
      cssPlanning: 'enabled',
      maxSplitCssGroups: undefined,
    });
    const configResolved = getHookHandler<[unknown], void | Promise<void>>({
      hook: plugin.configResolved,
      name: 'configResolved',
    });
    await configResolved.call({} as never, { command: 'serve' });
    const buildStart = getHookHandler<[unknown], void | Promise<void>>({
      hook: plugin.buildStart,
      name: 'buildStart',
    });
    await buildStart.call({ info() {} } as never, {});

    const beforeImports = plugin.api.getImportsByModule();
    const sharedId = (beforeImports.get(featureA) ?? []).find((id) => (
      id.startsWith('virtual:naidan-tailwind-css-module/')
      && (beforeImports.get(featureB) ?? []).includes(id)
    ));
    expect(sharedId).toBeDefined();
    if (sharedId === undefined) {
      throw new TypeError('Expected one shared CSS registration.');
    }

    const customMessages: unknown[] = [];
    const context = {
      environment: {
        name: 'client',
        moduleGraph: {
          getModuleById(id: string) {
            return { id };
          },
          getModulesByFile(filename: string) {
            return new Set([{ id: filename }]);
          },
        },
        async reloadModule() {},
        hot: {
          send(message: unknown) {
            customMessages.push(message);
          },
        },
      },
    };
    const hotUpdate = getHookHandler<[unknown], unknown | Promise<unknown>>({
      hook: plugin.hotUpdate,
      name: 'hotUpdate',
    });

    fs.writeFileSync(featureB, '<template><div tw-class="text-blue-500">B</div></template>\n');
    await hotUpdate.call(context as never, {
      file: featureB,
      timestamp: 1001,
      modules: [],
    });
    const privateImports = plugin.api.getImportsByModule();
    const privateA = (privateImports.get(featureA) ?? []).find((id) => (
      id.startsWith('virtual:naidan-tailwind-css-module/')
      && !(privateImports.get(featureB) ?? []).includes(id)
    ));
    expect(privateA).toBeDefined();
    expect(customMessages).toContainEqual({
      type: 'custom',
      event: 'naidan-tailwind:retire-css',
      data: { moduleIds: expect.arrayContaining([`\0${sharedId}`]) },
    });

    if (privateA === undefined) {
      throw new TypeError('Expected one private Feature A CSS registration.');
    }
    fs.writeFileSync(featureA, '<template><div>A</div></template>\n');
    await hotUpdate.call(context as never, {
      file: featureA,
      timestamp: 1002,
      modules: [],
    });
    expect(plugin.api.getImportsByModule().get(featureA) ?? []).not.toContain(privateA);
    expect(customMessages).toContainEqual({
      type: 'custom',
      event: 'naidan-tailwind:retire-css',
      data: { moduleIds: expect.arrayContaining([`\0${privateA}`]) },
    });
  });

  it('does not replay a completed duplicate HMR result after the same registration becomes active again', async () => {
    const root = createFixture();
    const sourceRoot = path.join(root, 'src');
    const featureA = path.join(sourceRoot, 'FeatureA.vue');
    const featureB = path.join(sourceRoot, 'FeatureB.vue');
    fs.writeFileSync(featureB, '<template><div tw-class="p-2">B</div></template>\n');
    const plugin = createTwClassVitePlugin({
      projectRoot: root,
      sourceRoot,
      entryModule: path.join(sourceRoot, 'main.ts'),
      tailwindCssPath: path.join(sourceRoot, 'style.css'),
      debugOutputDirectory: undefined,
      outputMode: 'split',
      cssPlanning: 'enabled',
      maxSplitCssGroups: undefined,
    });
    const configResolved = getHookHandler<[unknown], unknown | Promise<unknown>>({
      hook: plugin.configResolved,
      name: 'configResolved',
    });
    await configResolved.call({} as never, { command: 'serve' });
    const buildStart = getHookHandler<[unknown], unknown | Promise<unknown>>({
      hook: plugin.buildStart,
      name: 'buildStart',
    });
    await buildStart.call({ info() {} } as never, {});
    const hotUpdate = getHookHandler<[unknown], unknown | Promise<unknown>>({
      hook: plugin.hotUpdate,
      name: 'hotUpdate',
    });
    const customMessages: { data?: { moduleIds?: string[] } }[] = [];
    const context = {
      environment: {
        name: 'client',
        moduleGraph: {
          getModuleById() {
            return undefined;
          },
          getModulesByFile() {
            return undefined;
          },
        },
        async reloadModule() {},
        hot: {
          send(message: { data?: { moduleIds?: string[] } }) {
            customMessages.push(message);
          },
        },
      },
    };

    fs.writeFileSync(featureA, '<template><div tw-class="p-4">A</div></template>\n');
    await hotUpdate.call(context as never, { file: featureA, timestamp: 5000, modules: [] });
    fs.writeFileSync(featureB, '<template><div tw-class="p-4">B</div></template>\n');
    await hotUpdate.call(context as never, { file: featureB, timestamp: 5001, modules: [] });

    const activeSharedId = (plugin.api.getImportsByModule().get(featureA) ?? []).find((id) => (
      id.startsWith('virtual:naidan-tailwind-css-module/')
      && (plugin.api.getImportsByModule().get(featureB) ?? []).includes(id)
    ));
    expect(activeSharedId).toBeDefined();
    if (activeSharedId === undefined) {
      throw new TypeError('Expected a reactivated shared registration.');
    }

    customMessages.length = 0;
    await hotUpdate.call(context as never, { file: featureA, timestamp: 5000, modules: [] });

    expect(customMessages.flatMap(({ data }) => data?.moduleIds ?? [])).not.toContain(`\0${activeSharedId}`);
  });

  it('replans different files even when Vite reports the same HMR timestamp', async () => {
    const root = createFixture();
    const sourceRoot = path.join(root, 'src');
    const featureA = path.join(sourceRoot, 'FeatureA.vue');
    const featureB = path.join(sourceRoot, 'FeatureB.vue');
    const plugin = createTwClassVitePlugin({
      projectRoot: root,
      sourceRoot,
      entryModule: path.join(sourceRoot, 'main.ts'),
      tailwindCssPath: path.join(sourceRoot, 'style.css'),
      debugOutputDirectory: undefined,
      outputMode: 'split',
      cssPlanning: 'enabled',
      maxSplitCssGroups: undefined,
    });
    const configResolved = getHookHandler<[unknown], void | Promise<void>>({
      hook: plugin.configResolved,
      name: 'configResolved',
    });
    await configResolved.call({} as never, { command: 'serve' });
    const buildStart = getHookHandler<[unknown], void | Promise<void>>({
      hook: plugin.buildStart,
      name: 'buildStart',
    });
    await buildStart.call({ info() {} } as never, {});
    const hotUpdate = getHookHandler<[unknown], unknown | Promise<unknown>>({
      hook: plugin.hotUpdate,
      name: 'hotUpdate',
    });
    const context = {
      environment: {
        name: 'client',
        moduleGraph: {
          getModuleById() {
            return undefined;
          },
          getModulesByFile() {
            return undefined;
          },
        },
        async reloadModule() {},
        hot: { send() {} },
      },
    };

    fs.writeFileSync(featureA, '<template><div tw-class="p-4">A</div></template>\n');
    await hotUpdate.call(context as never, { file: featureA, timestamp: 2000, modules: [] });
    fs.writeFileSync(featureB, '<template><div tw-class="m-4">B</div></template>\n');
    await hotUpdate.call(context as never, { file: featureB, timestamp: 2000, modules: [] });

    expect(plugin.api.getPlan()?.candidates).toContain('p-4');
    expect(plugin.api.getPlan()?.candidates).toContain('m-4');
    expect(plugin.api.getPlan()?.candidates).not.toContain('p-2');
    expect(plugin.api.getPlan()?.candidates).not.toContain('text-blue-500');
  });

  it('serializes overlapping HMR replans so an older slow plan cannot overwrite the newest state', async () => {
    const root = createFixture();
    const sourceRoot = path.join(root, 'src');
    const featureA = path.join(sourceRoot, 'FeatureA.vue');
    const featureB = path.join(sourceRoot, 'FeatureB.vue');
    const plugin = createTwClassVitePlugin({
      projectRoot: root,
      sourceRoot,
      entryModule: path.join(sourceRoot, 'main.ts'),
      tailwindCssPath: path.join(sourceRoot, 'style.css'),
      debugOutputDirectory: undefined,
      outputMode: 'split',
      cssPlanning: 'enabled',
      maxSplitCssGroups: undefined,
    });
    const configResolved = getHookHandler<[unknown], unknown | Promise<unknown>>({
      hook: plugin.configResolved,
      name: 'configResolved',
    });
    await configResolved.call({} as never, { command: 'serve' });
    const buildStart = getHookHandler<[unknown], unknown | Promise<unknown>>({
      hook: plugin.buildStart,
      name: 'buildStart',
    });
    await buildStart.call({ info() {} } as never, {});
    const hotUpdate = getHookHandler<[unknown], unknown | Promise<unknown>>({
      hook: plugin.hotUpdate,
      name: 'hotUpdate',
    });
    const context = {
      environment: {
        name: 'client',
        moduleGraph: {
          getModuleById() {
            return undefined;
          },
          getModulesByFile() {
            return undefined;
          },
        },
        async reloadModule() {},
        hot: { send() {} },
      },
    };

    const slowCandidates = Array.from({ length: 240 }, (_, index) => `p-[${index + 1}px]`).join(' ');
    fs.writeFileSync(featureA, `<template><div tw-class="${slowCandidates}">A</div></template>\n`);
    const olderRefresh = hotUpdate.call(context as never, { file: featureA, timestamp: 3000, modules: [] });

    fs.writeFileSync(featureA, '<template><div tw-class="p-4">A</div></template>\n');
    fs.writeFileSync(featureB, '<template><div tw-class="m-4">B</div></template>\n');
    const newerRefresh = hotUpdate.call(context as never, { file: featureB, timestamp: 3001, modules: [] });
    await Promise.all([olderRefresh, newerRefresh]);

    expect(plugin.api.getPlan()?.candidates).toContain('p-4');
    expect(plugin.api.getPlan()?.candidates).toContain('m-4');
    expect(plugin.api.getPlan()?.candidates).not.toContain('p-[240px]');
    expect(plugin.api.getPlan()?.candidates).not.toContain('text-blue-500');
  });

  it('does not deduplicate distinct same-file edits that share an HMR timestamp', async () => {
    const root = createFixture();
    const sourceRoot = path.join(root, 'src');
    const featureA = path.join(sourceRoot, 'FeatureA.vue');
    const plugin = createTwClassVitePlugin({
      projectRoot: root,
      sourceRoot,
      entryModule: path.join(sourceRoot, 'main.ts'),
      tailwindCssPath: path.join(sourceRoot, 'style.css'),
      debugOutputDirectory: undefined,
      outputMode: 'split',
      cssPlanning: 'enabled',
      maxSplitCssGroups: undefined,
    });
    const configResolved = getHookHandler<[unknown], unknown | Promise<unknown>>({
      hook: plugin.configResolved,
      name: 'configResolved',
    });
    await configResolved.call({} as never, { command: 'serve' });
    const buildStart = getHookHandler<[unknown], unknown | Promise<unknown>>({
      hook: plugin.buildStart,
      name: 'buildStart',
    });
    await buildStart.call({ info() {} } as never, {});
    const hotUpdate = getHookHandler<[unknown], unknown | Promise<unknown>>({
      hook: plugin.hotUpdate,
      name: 'hotUpdate',
    });
    const context = {
      environment: {
        name: 'client',
        moduleGraph: {
          getModuleById() {
            return undefined;
          },
          getModulesByFile() {
            return undefined;
          },
        },
        async reloadModule() {},
        hot: { send() {} },
      },
    };

    fs.writeFileSync(featureA, '<template><div tw-class="p-4">A</div></template>\n');
    await hotUpdate.call(context as never, { file: featureA, timestamp: 4000, modules: [] });
    fs.writeFileSync(featureA, '<template><div tw-class="m-4">A</div></template>\n');
    await hotUpdate.call(context as never, { file: featureA, timestamp: 4000, modules: [] });

    expect(plugin.api.getPlan()?.candidates).toContain('m-4');
    expect(plugin.api.getPlan()?.candidates).not.toContain('p-4');
  });

  it('skips the sequential SSR environment invocation after the client refresh', async () => {
    const root = createFixture();
    const { hotUpdate, plugin, sourceRoot } = await createServeHarness({ root });
    const featureA = path.join(sourceRoot, 'FeatureA.vue');
    const clientReloads: unknown[] = [];
    const clientPayloads: unknown[] = [];
    const clientContext = createHotUpdateContext({
      environmentName: 'client',
      reloads: clientReloads,
      sentPayloads: clientPayloads,
      onSend: undefined,
    });
    const ssrReloads: unknown[] = [];
    const ssrPayloads: unknown[] = [];
    const ssrContext = createHotUpdateContext({
      environmentName: 'ssr',
      reloads: ssrReloads,
      sentPayloads: ssrPayloads,
      onSend: undefined,
    });

    fs.writeFileSync(featureA, '<template><div tw-class="p-4">A</div></template>\n');
    const options = { file: featureA, timestamp: 5000, modules: [] };
    await hotUpdate.call(clientContext as never, options);
    const planAfterClientRefresh = plugin.api.getPlan();
    await hotUpdate.call(ssrContext as never, options);

    expect(plugin.api.getPlan()).toBe(planAfterClientRefresh);
    expect(ssrReloads).toEqual([]);
    expect(ssrPayloads).toEqual([]);
  });

  it('skips source files outside the static Tailwind analysis boundary', async () => {
    const root = createFixture();
    const { hotUpdate, plugin, sourceRoot } = await createServeHarness({ root });
    const ignoredFile = path.join(sourceRoot, 'test-tmp', 'Ignored.vue');
    const reloads: unknown[] = [];
    const sentPayloads: unknown[] = [];
    const context = createHotUpdateContext({
      environmentName: 'client',
      reloads,
      sentPayloads,
      onSend: undefined,
    });
    const planBeforeIgnoredChange = plugin.api.getPlan();

    fs.mkdirSync(path.dirname(ignoredFile), { recursive: true });
    fs.writeFileSync(ignoredFile, '<template><div tw-class="p-8">ignored</div></template>\n');
    await hotUpdate.call(context as never, { file: ignoredFile, timestamp: 5001, modules: [] });

    expect(plugin.api.getPlan()).toBe(planBeforeIgnoredChange);
    expect(plugin.api.getPlan()?.candidates).not.toContain('p-8');
    expect(reloads).toEqual([]);
    expect(sentPayloads).toEqual([]);
  });

  it('replans when a local stylesheet dependency changes', async () => {
    const root = createFixture();
    const sourceRoot = path.join(root, 'src');
    const stylePath = path.join(sourceRoot, 'style.css');
    const themePath = path.join(sourceRoot, 'theme.css');
    fs.writeFileSync(stylePath, `\
@import "tailwindcss" source(none);
@import "./theme.css";
`);
    fs.writeFileSync(themePath, '.local-theme-marker { color: red; }\n');
    const { hotUpdate, plugin } = await createServeHarness({ root });
    const initialPlan = plugin.api.getPlan();
    const reloads: unknown[] = [];
    const context = {
      environment: {
        name: 'client',
        moduleGraph: {
          getModuleById(id: string) {
            return { id };
          },
          getModulesByFile() {
            return undefined;
          },
        },
        async reloadModule(module: unknown) {
          reloads.push(module);
        },
        hot: { send() {} },
      },
    };

    fs.writeFileSync(themePath, '.local-theme-marker { color: blue; }\n');
    await hotUpdate.call(context as never, { file: themePath, timestamp: 5009, modules: [] });

    expect(plugin.api.getPlan()).not.toBe(initialPlan);
    expect(plugin.api.getPlan()?.baselineCss).not.toBe(initialPlan?.baselineCss);
    expect(reloads.length).toBeGreaterThan(0);
  });

  it('records local stylesheet dependencies and skips unchanged dependency events', async () => {
    const root = createFixture();
    const sourceRoot = path.join(root, 'src');
    const stylePath = path.join(sourceRoot, 'style.css');
    const themePath = path.join(sourceRoot, 'theme.css');
    fs.writeFileSync(stylePath, `\
@import "tailwindcss" source(none);
@import "./theme.css";
`);
    fs.writeFileSync(themePath, '.local-theme-marker { color: red; }\n');
    const { hotUpdate, plugin } = await createServeHarness({ root });
    const context = createHotUpdateContext({
      environmentName: 'client',
      reloads: [],
      sentPayloads: [],
      onSend: undefined,
    });
    const initialPlan = plugin.api.getPlan();

    expect(initialPlan?.stylesheetDependencies).toContain(themePath);
    await hotUpdate.call(context as never, { file: themePath, timestamp: 5017, modules: [] });
    expect(plugin.api.getPlan()).toBe(initialPlan);

    const touchedAt = new Date(Date.now() + 1000);
    fs.utimesSync(themePath, touchedAt, touchedAt);
    await hotUpdate.call(context as never, { file: themePath, timestamp: 5018, modules: [] });
    expect(plugin.api.getPlan()).toBe(initialPlan);
  });

  it('skips companion stylesheet events after the entry stylesheet already applied them', async () => {
    const root = createFixture();
    const sourceRoot = path.join(root, 'src');
    const stylePath = path.join(sourceRoot, 'style.css');
    const themePath = path.join(sourceRoot, 'theme.css');
    const { hotUpdate, plugin } = await createServeHarness({ root });
    const context = createHotUpdateContext({
      environmentName: 'client',
      reloads: [],
      sentPayloads: [],
      onSend: undefined,
    });
    const initialPlan = plugin.api.getPlan();

    fs.writeFileSync(themePath, '.local-theme-marker { color: red; }\n');
    await hotUpdate.call(context as never, { file: themePath, timestamp: 5019, modules: [] });
    expect(plugin.api.getPlan()).toBe(initialPlan);

    fs.writeFileSync(stylePath, `\
@import "tailwindcss" source(none);
@import "./theme.css";
`);
    await hotUpdate.call(context as never, { file: stylePath, timestamp: 5020, modules: [] });
    const planWithTheme = plugin.api.getPlan();
    expect(planWithTheme).not.toBe(initialPlan);
    expect(planWithTheme?.stylesheetDependencies).toContain(themePath);

    await hotUpdate.call(context as never, { file: themePath, timestamp: 5021, modules: [] });
    expect(plugin.api.getPlan()).toBe(planWithTheme);

    fs.writeFileSync(stylePath, '@import "tailwindcss" source(none);\n');
    fs.rmSync(themePath);
    await hotUpdate.call(context as never, { file: stylePath, timestamp: 5022, modules: [] });
    const planWithoutTheme = plugin.api.getPlan();
    expect(planWithoutTheme).not.toBe(planWithTheme);
    expect(planWithoutTheme?.stylesheetDependencies).not.toContain(themePath);

    await hotUpdate.call(context as never, { file: themePath, timestamp: 5023, modules: [] });
    expect(plugin.api.getPlan()).toBe(planWithoutTheme);
  });

  it('recovers when a missing stylesheet dependency is created after the entry update fails', async () => {
    const root = createFixture();
    const sourceRoot = path.join(root, 'src');
    const stylePath = path.join(sourceRoot, 'style.css');
    const themePath = path.join(sourceRoot, 'late-theme.css');
    const { hotUpdate, plugin } = await createServeHarness({ root });
    const context = createHotUpdateContext({
      environmentName: 'client',
      reloads: [],
      sentPayloads: [],
      onSend: undefined,
    });
    const validPlan = plugin.api.getPlan();

    fs.writeFileSync(stylePath, `\
@import "tailwindcss" source(none);
@import "./late-theme.css";
`);
    await expect(hotUpdate.call(context as never, {
      file: stylePath,
      timestamp: 5027,
      modules: [],
    })).rejects.toThrow(/late-theme\.css/u);
    expect(plugin.api.getPlan()).toBe(validPlan);

    fs.writeFileSync(themePath, '.late-theme-marker { color: purple; }\n');
    await expect(hotUpdate.call(context as never, {
      file: themePath,
      timestamp: 5028,
      modules: [],
    })).resolves.toEqual([]);
    expect(plugin.api.getPlan()).not.toBe(validPlan);
    expect(plugin.api.getPlan()?.stylesheetDependencies).toContain(themePath);
    const recoveredPlan = plugin.api.getPlan();

    const unrelatedStylesheet = path.join(sourceRoot, 'unrelated-after-recovery.css');
    fs.writeFileSync(unrelatedStylesheet, '.unrelated { color: orange; }\n');
    await expect(hotUpdate.call(context as never, {
      file: unrelatedStylesheet,
      timestamp: 5029,
      modules: [],
    })).resolves.toEqual([]);
    expect(plugin.api.getPlan()).toBe(recoveredPlan);
  });

  it('skips same-content saves and mtime-only changes after a successful plan', async () => {
    const root = createFixture();
    const { hotUpdate, plugin, sourceRoot } = await createServeHarness({ root });
    const featureA = path.join(sourceRoot, 'FeatureA.vue');
    const context = createHotUpdateContext({
      environmentName: 'client',
      reloads: [],
      sentPayloads: [],
      onSend: undefined,
    });
    const initialPlan = plugin.api.getPlan();

    fs.writeFileSync(featureA, '<template><div tw-class="p-2">A</div></template>\n');
    await hotUpdate.call(context as never, { file: featureA, timestamp: 5010, modules: [] });
    expect(plugin.api.getPlan()).toBe(initialPlan);

    const touchedAt = new Date(Date.now() + 1000);
    fs.utimesSync(featureA, touchedAt, touchedAt);
    await hotUpdate.call(context as never, { file: featureA, timestamp: 5011, modules: [] });
    expect(plugin.api.getPlan()).toBe(initialPlan);
  });

  it('runs a trailing refresh when a source reverts while an older refresh is active', async () => {
    const root = createFixture();
    const { hotUpdate, plugin, sourceRoot } = await createServeHarness({ root });
    const featureA = path.join(sourceRoot, 'FeatureA.vue');
    const context = createHotUpdateContext({
      environmentName: 'client',
      reloads: [],
      sentPayloads: [],
      onSend: undefined,
    });
    const slowCandidates = Array.from({ length: 240 }, (_, index) => `p-[${index + 1}px]`).join(' ');

    fs.writeFileSync(featureA, `<template><div tw-class="${slowCandidates}">A</div></template>\n`);
    const olderRefresh = hotUpdate.call(context as never, {
      file: featureA,
      timestamp: 5004,
      modules: [],
    });
    await Promise.resolve();
    await Promise.resolve();

    fs.writeFileSync(featureA, '<template><div tw-class="p-2">A</div></template>\n');
    const revertingRefresh = hotUpdate.call(context as never, {
      file: featureA,
      timestamp: 5005,
      modules: [],
    });
    await Promise.all([olderRefresh, revertingRefresh]);

    expect(plugin.api.getPlan()?.candidates).toContain('p-2');
    expect(plugin.api.getPlan()?.candidates).not.toContain('p-[240px]');
  });

  it('rechecks edits and reversions delivered while asynchronous source reads are pending', async () => {
    const root = createFixture();
    const { hotUpdate, plugin, sourceRoot } = await createServeHarness({ root });
    const featureA = path.join(sourceRoot, 'FeatureA.vue');
    const originalSource = fs.readFileSync(featureA, 'utf8');
    const context = createHotUpdateContext({ environmentName: 'client', reloads: [], sentPayloads: [], onSend: undefined });
    const originalRead = fs.promises.readFile;
    let releaseRead = () => {};
    const readGate = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    let reportCaptured = () => {};
    const captured = new Promise<void>((resolve) => {
      reportCaptured = resolve;
    });
    let featureReads = 0;
    using _reads = vi.spyOn(fs.promises, 'readFile').mockImplementation(async (...args) => {
      const source = await Reflect.apply(originalRead, fs.promises, args) as Awaited<ReturnType<typeof originalRead>>;
      if (args[0] === featureA && ++featureReads === 1) {
        reportCaptured();
        await readGate;
      }
      return source;
    });

    fs.writeFileSync(featureA, '<template><div tw-class="p-4">A</div></template>');
    const first = hotUpdate.call(context as never, { file: featureA, timestamp: 5100, modules: [] });
    const updates = [first];
    await using _settleUpdates = {
      async [Symbol.asyncDispose]() {
        releaseRead();
        await Promise.all(updates);
      },
    };
    await captured;
    fs.writeFileSync(featureA, '<template><div tw-class="p-8">A</div></template>');
    const changing = hotUpdate.call(context as never, { file: featureA, timestamp: 5101, modules: [] });
    updates.push(changing);
    fs.writeFileSync(featureA, originalSource);
    const reverting = hotUpdate.call(context as never, { file: featureA, timestamp: 5102, modules: [] });
    updates.push(reverting);
    releaseRead();
    await Promise.all([first, changing, reverting]);

    expect(plugin.api.getPlan()?.candidates).toContain('p-2');
    expect(plugin.api.getPlan()?.candidates).not.toContain('p-4');
    expect(plugin.api.getPlan()?.candidates).not.toContain('p-8');
    expect(featureReads).toBe(2);
  });

  it.each([
    { initialState: 'valid', action: 'edit' },
    { initialState: 'invalid', action: 'edit' },
    { initialState: 'valid', action: 'delete' },
  ] as const)('serializes $action behind a pending $initialState initial source analysis', async ({ initialState, action }) => {
    const root = createFixture();
    const sourceRoot = path.join(root, 'src');
    const featureA = path.join(sourceRoot, 'FeatureA.vue');
    if (initialState === 'invalid') {
      fs.writeFileSync(featureA, '<template><div tw-content-class="p-2">A</div></template>');
    }
    const plugin = createTwClassVitePlugin({
      projectRoot: root,
      sourceRoot,
      entryModule: path.join(sourceRoot, 'main.ts'),
      tailwindCssPath: path.join(sourceRoot, 'style.css'),
      debugOutputDirectory: undefined,
      outputMode: 'split',
      cssPlanning: 'enabled',
      maxSplitCssGroups: undefined,
    });
    const configResolved = getHookHandler<[unknown], void | Promise<void>>({ hook: plugin.configResolved, name: 'configResolved' });
    await configResolved.call({} as never, { command: 'serve' });
    const buildStart = getHookHandler<[unknown], void | Promise<void>>({ hook: plugin.buildStart, name: 'buildStart' });
    const hotUpdate = getHookHandler<[unknown], unknown | Promise<unknown>>({ hook: plugin.hotUpdate, name: 'hotUpdate' });
    const context = createHotUpdateContext({ environmentName: 'client', reloads: [], sentPayloads: [], onSend: undefined });
    const originalRead = fs.promises.readFile;
    let releaseRead = () => {};
    const readGate = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    let reportCaptured = () => {};
    const captured = new Promise<void>((resolve) => {
      reportCaptured = resolve;
    });
    let featureReads = 0;
    using _reads = vi.spyOn(fs.promises, 'readFile').mockImplementation(async (...args) => {
      const firstFeatureRead = args[0] === featureA && ++featureReads === 1;
      const source = await Reflect.apply(originalRead, fs.promises, args) as Awaited<ReturnType<typeof originalRead>>;
      if (firstFeatureRead) {
        reportCaptured();
        await readGate;
      }
      return source;
    });
    const initialization = Promise.resolve(buildStart.call({ info() {} } as never, {}))
      .then(() => undefined, (error: unknown) => error);
    const updates: unknown[] = [initialization];
    await using _settleUpdates = {
      async [Symbol.asyncDispose]() {
        releaseRead();
        await Promise.all(updates);
      },
    };
    await captured;
    switch (action) {
    case 'edit':
      fs.writeFileSync(featureA, '<template><div tw-class="p-4">A</div></template>');
      break;
    case 'delete':
      fs.rmSync(featureA);
      break;
    default: {
      const _ex: never = action;
      throw new Error(`Unhandled initial source action: ${String(_ex)}`);
    }
    }
    const update = hotUpdate.call(context as never, { file: featureA, timestamp: 5103, modules: [] });
    updates.push(update);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(featureReads).toBe(1);
    releaseRead();
    const initialError = await initialization;
    await update;

    if (initialState === 'invalid') {
      expect(initialError).toBeInstanceOf(Error);
      expect(String(initialError)).toContain('Unknown Tailwind class attribute');
    } else {
      expect(initialError).toBeUndefined();
    }
    expect(plugin.api.getPlan()?.candidates).not.toContain('p-2');
    if (action === 'delete') {
      expect(featureReads).toBe(1);
      expect(plugin.api.getImportsByModule().has(featureA)).toBe(false);
    } else {
      expect(featureReads).toBe(2);
      expect(plugin.api.getPlan()?.candidates).toContain('p-4');
    }
  });

  it('coalesces a synchronous deletion burst and applies the retirement result once', async () => {
    const root = createFixture();
    const { hotUpdate, plugin, sourceRoot } = await createServeHarness({ root });
    const featureA = path.join(sourceRoot, 'FeatureA.vue');
    const featureB = path.join(sourceRoot, 'FeatureB.vue');
    const reloads: unknown[] = [];
    const sentPayloads: unknown[] = [];
    let planWhenRetirementWasSent: ReturnType<typeof plugin.api.getPlan>;
    const context = createHotUpdateContext({
      environmentName: 'client',
      reloads,
      sentPayloads,
      onSend() {
        planWhenRetirementWasSent = plugin.api.getPlan();
      },
    });

    fs.rmSync(featureA);
    const firstUpdate = hotUpdate.call(context as never, { file: featureA, timestamp: 5002, modules: [] });
    fs.rmSync(featureB);
    const secondUpdate = hotUpdate.call(context as never, { file: featureB, timestamp: 5003, modules: [] });
    await Promise.all([firstUpdate, secondUpdate]);

    expect(sentPayloads).toHaveLength(1);
    expect(plugin.api.getPlan()).toBe(planWhenRetirementWasSent);
    expect(plugin.api.getPlan()?.candidates).not.toContain('p-2');
    expect(plugin.api.getPlan()?.candidates).not.toContain('text-blue-500');
  });

  it('converges to the renamed source file after delete and create notifications', async () => {
    const root = createFixture();
    const { hotUpdate, plugin, sourceRoot } = await createServeHarness({ root });
    const previousFile = path.join(sourceRoot, 'FeatureA.vue');
    const renamedFile = path.join(sourceRoot, 'FeatureRenamed.vue');
    const context = createHotUpdateContext({
      environmentName: 'client',
      reloads: [],
      sentPayloads: [],
      onSend: undefined,
    });

    fs.renameSync(previousFile, renamedFile);
    await Promise.all([
      hotUpdate.call(context as never, { file: previousFile, timestamp: 5012, modules: [] }),
      hotUpdate.call(context as never, { file: renamedFile, timestamp: 5013, modules: [] }),
    ]);

    expect(plugin.api.getPlan()?.candidates).toContain('p-2');
    expect(plugin.api.getImportsByModule().has(previousFile)).toBe(false);
    expect(plugin.api.getImportsByModule().has(renamedFile)).toBe(true);
  });

  it('keeps the last valid plan after a failed refresh and recovers on the next change', async () => {
    const root = createFixture();
    const { hotUpdate, plugin, sourceRoot } = await createServeHarness({ root });
    const featureA = path.join(sourceRoot, 'FeatureA.vue');
    const context = createHotUpdateContext({
      environmentName: 'client',
      reloads: [],
      sentPayloads: [],
      onSend: undefined,
    });
    const validPlan = plugin.api.getPlan();

    fs.writeFileSync(featureA, '<template><div tw-class="bg-reed-500">A</div></template>\n');
    await expect(hotUpdate.call(context as never, {
      file: featureA,
      timestamp: 5014,
      modules: [],
    })).rejects.toThrow(/bg-reed-500/u);
    expect(plugin.api.getPlan()).toBe(validPlan);

    await expect(hotUpdate.call(context as never, {
      file: featureA,
      timestamp: 5015,
      modules: [],
    })).rejects.toThrow(/bg-reed-500/u);
    expect(plugin.api.getPlan()).toBe(validPlan);

    fs.writeFileSync(featureA, '<template><div tw-class="p-4">A</div></template>\n');
    await expect(hotUpdate.call(context as never, {
      file: featureA,
      timestamp: 5016,
      modules: [],
    })).resolves.toEqual([]);
    expect(plugin.api.getPlan()).not.toBe(validPlan);
    expect(plugin.api.getPlan()?.candidates).toContain('p-4');
    expect(plugin.api.getPlan()?.candidates).not.toContain('p-2');
  });

  it('retries HMR application after a reload failure before committing the new input state', async () => {
    const root = createFixture();
    const { hotUpdate, plugin, sourceRoot } = await createServeHarness({ root });
    const featureA = path.join(sourceRoot, 'FeatureA.vue');
    const expectedError = new Error('reload failed');
    const reloads: unknown[] = [];
    let shouldFail = true;
    const context = {
      environment: {
        name: 'client',
        moduleGraph: {
          getModuleById(id: string) {
            return { id };
          },
          getModulesByFile() {
            return undefined;
          },
        },
        async reloadModule(module: unknown) {
          reloads.push(module);
          if (shouldFail) {
            shouldFail = false;
            throw expectedError;
          }
        },
        hot: { send() {} },
      },
    };

    fs.writeFileSync(featureA, '<template><div tw-class="p-4">A</div></template>\n');
    await expect(hotUpdate.call(context as never, {
      file: featureA,
      timestamp: 5024,
      modules: [],
    })).rejects.toBe(expectedError);
    const reloadCountAfterFailure = reloads.length;
    expect(plugin.api.getPlan()?.candidates).toContain('p-4');

    await expect(hotUpdate.call(context as never, {
      file: featureA,
      timestamp: 5025,
      modules: [],
    })).resolves.toEqual([]);
    expect(reloads.length).toBeGreaterThan(reloadCountAfterFailure);
    const appliedPlan = plugin.api.getPlan();
    const reloadCountAfterRecovery = reloads.length;

    await expect(hotUpdate.call(context as never, {
      file: featureA,
      timestamp: 5026,
      modules: [],
    })).resolves.toEqual([]);
    expect(plugin.api.getPlan()).toBe(appliedPlan);
    expect(reloads).toHaveLength(reloadCountAfterRecovery);
  });

  it('restores the last applied source after a partially delivered CSS update fails', async () => {
    const root = createFixture();
    const { hotUpdate, plugin, sourceRoot } = await createServeHarness({ root });
    const featureA = path.join(sourceRoot, 'FeatureA.vue');
    const originalSource = fs.readFileSync(featureA, 'utf8');
    const load = getHookHandler<[string], string>({ hook: plugin.load, name: 'load' });
    const deliveredModules = new Map<string, string>();
    const originalModules = new Map((plugin.api.getImportsByModule().get(featureA) ?? []).map((id) => [
      `\0${id}`, load.call({} as never, `\0${id}`),
    ]));
    let failReload = true;
    const context = {
      environment: {
        name: 'client',
        moduleGraph: {
          getModuleById(id: string) {
            return { id };
          },
          getModulesByFile() {
            return undefined;
          },
        },
        async reloadModule({ id }: { id: string }) {
          deliveredModules.set(id, load.call({} as never, id));
          if (failReload) {
            throw new Error('interrupted CSS delivery');
          }
        },
        hot: { send() {} },
      },
    };

    fs.writeFileSync(featureA, '<template><div tw-class="p-4">A</div></template>\n');
    await expect(hotUpdate.call(context as never, {
      file: featureA,
      timestamp: 6000,
      modules: [],
    })).rejects.toThrow('interrupted CSS delivery');
    expect(plugin.api.getPlan()?.candidates).toContain('p-4');
    expect(deliveredModules.size).toBeGreaterThan(0);

    failReload = false;
    fs.writeFileSync(featureA, originalSource);
    await hotUpdate.call(context as never, { file: featureA, timestamp: 6001, modules: [] });

    expect(plugin.api.getPlan()?.candidates).toContain('p-2');
    expect(plugin.api.getPlan()?.candidates).not.toContain('p-4');
    for (const [id, originalModule] of originalModules) {
      expect(deliveredModules.get(id)).toBe(originalModule);
    }
  });

  it('reinstalls a restored registration after its retirement notification failed', async () => {
    const root = createFixture();
    const { hotUpdate, plugin, sourceRoot } = await createServeHarness({ root });
    const featureA = path.join(sourceRoot, 'FeatureA.vue');
    const originalSource = fs.readFileSync(featureA, 'utf8');
    const originalImports = plugin.api.getImportsByModule().get(featureA) ?? [];
    expect(originalImports.length).toBeGreaterThan(0);
    const load = getHookHandler<[string], string>({ hook: plugin.load, name: 'load' });
    const deliveredModules = new Map<string, string>();
    const retirements: unknown[] = [];
    let failRetirement = true;
    const context = {
      environment: {
        name: 'client',
        moduleGraph: {
          getModuleById(id: string) {
            return { id };
          },
          getModulesByFile() {
            return undefined;
          },
        },
        async reloadModule({ id }: { id: string }) {
          deliveredModules.set(id, load.call({} as never, id));
        },
        hot: {
          send(payload: unknown) {
            if (failRetirement) {
              throw new Error('interrupted CSS retirement');
            }
            retirements.push(payload);
          },
        },
      },
    };

    fs.writeFileSync(featureA, '<template><div>A</div></template>\n');
    await expect(hotUpdate.call(context as never, {
      file: featureA,
      timestamp: 6002,
      modules: [],
    })).rejects.toThrow('interrupted CSS retirement');
    expect(deliveredModules.get(`\0${originalImports[0]}`)).toBe('export {};');

    failRetirement = false;
    fs.writeFileSync(featureA, originalSource);
    await hotUpdate.call(context as never, { file: featureA, timestamp: 6003, modules: [] });

    expect(plugin.api.getImportsByModule().get(featureA)).toEqual(originalImports);
    for (const id of originalImports) {
      expect(deliveredModules.get(`\0${id}`)).toContain('registerTailwindCssModule');
    }
    expect(retirements).toHaveLength(0);
  });

  it('rechecks a stylesheet save whose notification arrives after compilation', async () => {
    const root = createFixture();
    const entry = path.join(root, 'src/style.css');
    const source = path.join(root, 'src/FeatureA.vue');
    const red = `\
@import "tailwindcss" source(none);
.snapshot-marker { color: red; }
`;
    const blue = red.replace('color: red', 'color: blue');
    fs.writeFileSync(entry, red);
    const { plugin, hotUpdate } = await createServeHarness({ root });
    const context = createHotUpdateContext({ environmentName: 'client', reloads: [], sentPayloads: [], onSend: undefined });
    const originalRead = fs.readFileSync;
    let reads = 0;
    const read = vi.spyOn(fs, 'readFileSync').mockImplementation((...args) => {
      const result = Reflect.apply(originalRead, fs, args) as ReturnType<typeof fs.readFileSync>;
      if (args[0] === entry && args[1] === 'utf8') {
        reads += 1;
        // The snapshot, validator, baseline, and global compiler have now read
        // red. Save blue before compilation returns, but deliver its event later.
        if (reads === 4) {
          fs.writeFileSync(entry, blue);
        }
      }
      return result;
    });
    using _restore = {
      [Symbol.dispose]() {
        read.mockRestore();
      },
    };
    fs.writeFileSync(source, '<template><div tw-class="p-4">A</div></template>');
    await hotUpdate.call(context as never, { file: source, timestamp: 6100, modules: [] });
    read.mockRestore();
    expect(fs.readFileSync(entry, 'utf8')).toBe(blue);
    expect(plugin.api.getPlan()?.baselineCss).toContain('color: red');

    await hotUpdate.call(context as never, { file: entry, timestamp: 6101, modules: [] });
    expect(plugin.api.getPlan()?.baselineCss).toContain('color: blue');
    expect(plugin.api.getPlan()?.baselineCss).not.toContain('color: red');
  });

  it.each(['startup', 'refresh'] as const)('queues a newly discovered stylesheet save during %s compilation', async (phase) => {
    const root = createFixture();
    const sourceRoot = path.join(root, 'src');
    const entry = path.join(sourceRoot, 'style.css');
    const theme = path.join(sourceRoot, 'new-theme.css');
    const plugin = createTwClassVitePlugin({
      projectRoot: root,
      sourceRoot,
      entryModule: path.join(sourceRoot, 'main.ts'),
      tailwindCssPath: entry,
      debugOutputDirectory: undefined,
      outputMode: 'split',
      cssPlanning: 'enabled',
      maxSplitCssGroups: undefined,
    });
    const configResolved = getHookHandler<[unknown], void | Promise<void>>({ hook: plugin.configResolved, name: 'configResolved' });
    await configResolved.call({} as never, { command: 'serve' });
    const buildStart = getHookHandler<[unknown], void | Promise<void>>({ hook: plugin.buildStart, name: 'buildStart' });
    const hotUpdate = getHookHandler<[unknown], unknown | Promise<unknown>>({ hook: plugin.hotUpdate, name: 'hotUpdate' });
    if (phase === 'refresh') {
      await buildStart.call({ info() {} } as never, {});
    }
    const red = '.new-dependency-marker { color: red; }';
    const blue = red.replace('color: red', 'color: blue');
    fs.writeFileSync(theme, red);
    fs.appendFileSync(entry, '@import "./new-theme.css";');
    const context = createHotUpdateContext({ environmentName: 'client', reloads: [], sentPayloads: [], onSend: undefined });
    const originalRead = fs.readFileSync;
    const updates: unknown[] = [];
    let themeReads = 0;
    using _reads = vi.spyOn(fs, 'readFileSync').mockImplementation((...args) => {
      const source = Reflect.apply(originalRead, fs, args) as ReturnType<typeof originalRead>;
      if (args[0] === theme && args[1] === 'utf8' && ++themeReads === 4) {
        // The snapshot, validator, baseline and global compiler consumed red.
        // Deliver this edit before that first dependency plan is installed.
        queueMicrotask(() => {
          fs.writeFileSync(theme, blue);
          updates.push(hotUpdate.call(context as never, { file: theme, timestamp: 6103, modules: [] }));
        });
      }
      return source;
    });
    await using _settleUpdates = {
      async [Symbol.asyncDispose]() {
        await Promise.all(updates);
      },
    };
    const first = phase === 'startup'
      ? buildStart.call({ info() {} } as never, {})
      : hotUpdate.call(context as never, { file: entry, timestamp: 6102, modules: [] });
    updates.push(first);
    await first;
    await Promise.all(updates);

    expect(updates).toHaveLength(2);
    expect(plugin.api.getPlan()?.baselineCss).toContain('color: blue');
    expect(plugin.api.getPlan()?.baselineCss).not.toContain('color: red');
  });

  it('refreshes an imported stylesheet outside the source directory and skips its repeated save', async () => {
    const root = createFixture();
    const stylesheet = path.join(root, 'theme.css');
    fs.writeFileSync(stylesheet, '.external-theme-marker { color: red; }\n');
    fs.appendFileSync(path.join(root, 'src/style.css'), '@import "../theme.css";\n');
    const { hotUpdate, plugin } = await createServeHarness({ root });
    const context = createHotUpdateContext({
      environmentName: 'client',
      reloads: [],
      sentPayloads: [],
      onSend: undefined,
    });
    expect(plugin.api.getPlan()?.baselineCss).toContain('color: red');

    fs.writeFileSync(stylesheet, '.external-theme-marker { color: blue; }\n');
    await hotUpdate.call(context as never, { file: stylesheet, timestamp: 6004, modules: [] });

    expect(plugin.api.getPlan()?.baselineCss).toContain('color: blue');
    expect(plugin.api.getPlan()?.baselineCss).not.toContain('color: red');
    const appliedPlan = plugin.api.getPlan();
    await hotUpdate.call(context as never, { file: stylesheet, timestamp: 6005, modules: [] });
    expect(plugin.api.getPlan()).toBe(appliedPlan);
  });

  it('recovers when a missing imported project stylesheet outside src is created', async () => {
    const root = createFixture();
    const { hotUpdate, plugin, sourceRoot } = await createServeHarness({ root });
    const stylesheet = path.join(root, 'late-theme.css');
    const stylePath = path.join(sourceRoot, 'style.css');
    const context = createHotUpdateContext({
      environmentName: 'client',
      reloads: [],
      sentPayloads: [],
      onSend: undefined,
    });
    fs.appendFileSync(stylePath, '@import "../late-theme.css";\n');
    await expect(hotUpdate.call(context as never, {
      file: stylePath,
      timestamp: 6006,
      modules: [],
    })).rejects.toThrow(/late-theme\.css/u);

    fs.writeFileSync(stylesheet, '.external-theme-marker { color: purple; }\n');
    await hotUpdate.call(context as never, { file: stylesheet, timestamp: 6007, modules: [] });

    expect(plugin.api.getPlan()?.stylesheetDependencies).toContain(stylesheet);
    expect(plugin.api.getPlan()?.baselineCss).toContain('color: purple');
    const recoveredPlan = plugin.api.getPlan();
    const unrelatedPath = path.join(root, 'unrelated.css');
    fs.writeFileSync(unrelatedPath, '.unrelated { color: orange; }\n');
    await hotUpdate.call(context as never, { file: unrelatedPath, timestamp: 6008, modules: [] });
    expect(plugin.api.getPlan()).toBe(recoveredPlan);
  });

  it('retries a restored global stylesheet after single-asset CSS delivery failed', async () => {
    const root = createFixture();
    const sourceRoot = path.join(root, 'src');
    const stylePath = path.join(sourceRoot, 'style.css');
    const plugin = createTwClassVitePlugin({
      projectRoot: root,
      sourceRoot,
      entryModule: path.join(sourceRoot, 'main.ts'),
      tailwindCssPath: stylePath,
      debugOutputDirectory: undefined,
      outputMode: 'single',
      cssPlanning: 'enabled',
      maxSplitCssGroups: undefined,
    });
    getHookHandler<[unknown], void>({ hook: plugin.configResolved, name: 'configResolved' })
      .call({} as never, { command: 'serve' });
    await getHookHandler<[unknown], Promise<void>>({ hook: plugin.buildStart, name: 'buildStart' })
      .call({ info() {} } as never, {});
    const hotUpdate = getHookHandler<[unknown], Promise<unknown>>({ hook: plugin.hotUpdate, name: 'hotUpdate' });
    const featureA = path.join(sourceRoot, 'FeatureA.vue');
    const originalSource = fs.readFileSync(featureA, 'utf8');
    const originalCss = plugin.api.getPlan()?.entryCss;
    const load = getHookHandler<[string], string>({ hook: plugin.load, name: 'load' });
    const deliveredCss: string[] = [];
    let failReload = true;
    const context = {
      environment: {
        name: 'client',
        moduleGraph: {
          getModuleById() {
            return undefined;
          },
          getModulesByFile(filename: string) {
            return filename === stylePath ? new Set([{ id: filename }]) : undefined;
          },
        },
        async reloadModule({ id }: { id: string }) {
          deliveredCss.push(load.call({} as never, id));
          if (failReload) {
            throw new Error('interrupted global stylesheet update');
          }
        },
        hot: { send() {} },
      },
    };
    fs.writeFileSync(featureA, '<template><div tw-class="p-4">A</div></template>\n');
    await expect(hotUpdate.call(context as never, {
      file: featureA,
      timestamp: 6009,
      modules: [],
    })).rejects.toThrow('interrupted global stylesheet update');
    expect(deliveredCss).toHaveLength(1);
    expect(deliveredCss[0]).not.toBe(originalCss);

    failReload = false;
    fs.writeFileSync(featureA, originalSource);
    await hotUpdate.call(context as never, { file: featureA, timestamp: 6010, modules: [] });

    expect(deliveredCss).toHaveLength(2);
    expect(deliveredCss[1]).toBe(originalCss);
    expect(plugin.api.getPlan()?.entryCss).toBe(originalCss);
  });

  it('retires intermediate shared registrations after repeated failures and an exact source restoration', async () => {
    const root = createFixture();
    const { hotUpdate, plugin, sourceRoot } = await createServeHarness({ root });
    const featureA = path.join(sourceRoot, 'FeatureA.vue');
    const featureB = path.join(sourceRoot, 'FeatureB.vue');
    const originalA = fs.readFileSync(featureA, 'utf8');
    const originalB = fs.readFileSync(featureB, 'utf8');
    const originalImports = new Map(plugin.api.getImportsByModule());
    const initialIds = new Set([...originalImports.values()].flat());
    const reloads: string[] = [];
    const retirements: unknown[] = [];
    let failure: 'owner' | 'first' | undefined = 'owner';
    const context = {
      environment: {
        name: 'client',
        moduleGraph: {
          getModuleById(id: string) {
            return { id };
          },
          getModulesByFile(filename: string) {
            return new Set([{ id: filename }]);
          },
        },
        async reloadModule({ id }: { id: string }) {
          reloads.push(id);
          if (failure === 'first' || (failure === 'owner' && !id.startsWith('\0'))) {
            throw new Error('interrupted ownership update');
          }
        },
        hot: {
          send(payload: unknown) {
            retirements.push(payload);
          },
        },
      },
    };

    fs.writeFileSync(featureB, '<template><div tw-class="text-blue-500 p-2">B</div></template>\n');
    await expect(hotUpdate.call(context as never, {
      file: featureB,
      timestamp: 6011,
      modules: [],
    })).rejects.toThrow('interrupted ownership update');
    const intermediateIds = [...new Set([...plugin.api.getImportsByModule().values()].flat())]
      .filter((id) => !initialIds.has(id));
    expect(intermediateIds.length).toBeGreaterThan(0);

    failure = 'first';
    fs.writeFileSync(featureB, originalB);
    fs.writeFileSync(featureA, '<template><div tw-class="p-4">A</div></template>\n');
    await expect(hotUpdate.call(context as never, {
      file: featureA,
      timestamp: 6012,
      modules: [],
    })).rejects.toThrow('interrupted ownership update');

    failure = undefined;
    reloads.length = 0;
    retirements.length = 0;
    fs.writeFileSync(featureA, originalA);
    await hotUpdate.call(context as never, { file: featureA, timestamp: 6013, modules: [] });

    expect(plugin.api.getImportsByModule()).toEqual(originalImports);
    expect(reloads).toContain(featureA);
    expect(reloads).toContain(featureB);
    expect(retirements).toContainEqual({
      type: 'custom',
      event: 'naidan-tailwind:retire-css',
      data: { moduleIds: expect.arrayContaining(intermediateIds.map((id) => `\0${id}`)) },
    });
  });

  it('forgets failed outside stylesheet dependencies after a successful source restoration', async () => {
    const root = createFixture();
    const outsideDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'naidan-abandoned-stylesheet-'));
    temporaryDirectories.push(outsideDirectory);
    const stylesheet = path.join(outsideDirectory, 'theme.css');
    const { plugin, hotUpdate } = await createServeHarness({ root });
    const reloads: unknown[] = [];
    const sentPayloads: unknown[] = [];
    const context = createHotUpdateContext({ environmentName: 'client', reloads, sentPayloads, onSend: undefined });
    const entry = path.join(root, 'src/style.css');
    const original = fs.readFileSync(entry, 'utf8');
    fs.appendFileSync(entry, `@import ${JSON.stringify(stylesheet)};\n`);
    await expect(hotUpdate.call(context as never, {
      file: entry,
      modules: [],
      timestamp: 1,
      type: 'update',
    })).rejects.toThrow();
    fs.writeFileSync(entry, original);
    await hotUpdate.call(context as never, {
      file: entry,
      modules: [],
      timestamp: 2,
      type: 'update',
    });
    const restoredPlan = plugin.api.getPlan();
    expect(restoredPlan?.stylesheetDependencies).not.toContain(stylesheet);
    reloads.length = 0;
    sentPayloads.length = 0;

    fs.writeFileSync(stylesheet, '.unused-theme-marker { color: purple; }\n');
    await hotUpdate.call(context as never, {
      file: stylesheet,
      modules: [],
      timestamp: 3,
      type: 'create',
    });
    expect(plugin.api.getPlan()).toBe(restoredPlan);
    expect(reloads).toEqual([]);
    expect(sentPayloads).toEqual([]);
  });

  it('reloads the global stylesheet when single-asset candidate CSS changes', async () => {
    const root = createFixture();
    const sourceRoot = path.join(root, 'src');
    const stylePath = path.join(sourceRoot, 'style.css');
    const plugin = createTwClassVitePlugin({
      projectRoot: root,
      sourceRoot,
      entryModule: path.join(sourceRoot, 'main.ts'),
      tailwindCssPath: stylePath,
      debugOutputDirectory: path.join(root, 'dist/debug-tailwind'),
      outputMode: 'single',
      cssPlanning: 'enabled',
      maxSplitCssGroups: undefined,
    });
    const configResolved = getHookHandler<[unknown], void | Promise<void>>({
      hook: plugin.configResolved,
      name: 'configResolved',
    });
    await configResolved.call({} as never, { command: 'serve' });
    const buildStart = getHookHandler<[unknown], void | Promise<void>>({
      hook: plugin.buildStart,
      name: 'buildStart',
    });
    await buildStart.call({ info() {} } as never, {});

    const featureA = path.join(sourceRoot, 'FeatureA.vue');
    fs.writeFileSync(featureA, '<template><div tw-class="p-4">A</div></template>\n');
    const styleModule = { id: stylePath };
    const reloads: unknown[] = [];
    const context = {
      environment: {
        name: 'client',
        moduleGraph: {
          getModuleById() {
            return undefined;
          },
          getModulesByFile(filename: string) {
            return filename === stylePath ? new Set([styleModule]) : undefined;
          },
        },
        async reloadModule(module: unknown) {
          reloads.push(module);
        },
        hot: { send() {} },
      },
    };
    const hotUpdate = getHookHandler<[unknown], unknown | Promise<unknown>>({
      hook: plugin.hotUpdate,
      name: 'hotUpdate',
    });
    await hotUpdate.call(context as never, {
      file: featureA,
      timestamp: Date.now(),
      modules: [],
    });

    expect(reloads).toContain(styleModule);
  });
});

describe('static Tailwind production bundle integrity', () => {
  const projectRoot = '/fixture';
  const entryModule = '/fixture/src/main.ts';
  const lazyModule = '/fixture/src/Lazy.vue';
  const registrationPublicId = 'virtual:naidan-tailwind-css-module/group.js';
  const registrationResolvedId = `\0${registrationPublicId}`;
  const initialRegistrationResolvedId = '\0virtual:naidan-tailwind-css-module/initial.js';
  const runtimeResolvedId = '\0virtual:naidan-tailwind-css-runtime';
  const moduleSourceByResolvedId = new Map([[registrationResolvedId, 'registration source']]);
  const registrationDependenciesByResolvedId = new Map<string, string[]>();

  function bundleWith({
    includeRegistration,
    includeRuntime,
    duplicateRegistration = false,
    registrationInOrphanChunk = false,
  }: {
    includeRegistration: boolean,
    includeRuntime: boolean,
    duplicateRegistration?: boolean,
    registrationInOrphanChunk?: boolean,
  }) {
    const entryModules: Record<string, unknown> = { [entryModule]: {} };
    const lazyModules: Record<string, unknown> = { [lazyModule]: {} };
    if (includeRegistration) {
      lazyModules[registrationResolvedId] = {};
    }
    if (includeRuntime) {
      lazyModules[runtimeResolvedId] = {};
    }
    const bundle: Record<string, {
      type: string,
      fileName: string,
      imports: string[],
      dynamicImports?: string[],
      isEntry?: boolean,
      modules: Record<string, unknown>,
    }> = {
      'entry.js': {
        type: 'chunk',
        fileName: 'entry.js',
        imports: [],
        dynamicImports: ['lazy.js'],
        isEntry: true,
        modules: entryModules,
      },
      'lazy.js': {
        type: 'chunk',
        fileName: 'lazy.js',
        imports: [],
        modules: lazyModules,
      },
    };
    if (registrationInOrphanChunk) {
      delete lazyModules[registrationResolvedId];
      delete lazyModules[runtimeResolvedId];
      bundle['orphan.js'] = {
        type: 'chunk',
        fileName: 'orphan.js',
        imports: [],
        modules: {
          ...(includeRegistration ? { [registrationResolvedId]: {} } : {}),
          ...(includeRuntime ? { [runtimeResolvedId]: {} } : {}),
        },
      };
    }
    if (duplicateRegistration) {
      bundle['duplicate.js'] = {
        type: 'chunk',
        fileName: 'duplicate.js',
        imports: [],
        modules: { [registrationResolvedId]: {} },
      };
    }
    return bundle;
  }

  it('accepts one retained registration for each emitted owner module', () => {
    expect(() => assertCssRegistrationBundleIntegrity({
      bundle: bundleWith({ includeRegistration: true, includeRuntime: true }),
      projectRoot,
      importsByModule: new Map([[lazyModule, [registrationPublicId]]]),
      moduleSourceByResolvedId,
      registrationDependenciesByResolvedId,
    })).not.toThrow();
  });

  it('treats a registration dependency as required by the same emitted owner graph', () => {
    expect(() => assertCssRegistrationBundleIntegrity({
      bundle: {
        'broker.js': {
          type: 'chunk',
          fileName: 'broker.js',
          imports: [],
          isEntry: true,
          modules: {
            [lazyModule]: {},
            [registrationResolvedId]: {},
            [initialRegistrationResolvedId]: {},
            [runtimeResolvedId]: {},
          },
        },
      },
      projectRoot,
      importsByModule: new Map([[lazyModule, [registrationPublicId]]]),
      moduleSourceByResolvedId: new Map([
        [registrationResolvedId, 'registration source'],
        [initialRegistrationResolvedId, 'initial source'],
      ]),
      registrationDependenciesByResolvedId: new Map([
        [registrationResolvedId, [initialRegistrationResolvedId]],
        [initialRegistrationResolvedId, []],
      ]),
    })).not.toThrow();
  });

  it('accepts registration modules promoted into the initial graph', () => {
    expect(() => assertCssRegistrationBundleIntegrity({
      bundle: {
        'entry.js': {
          type: 'chunk',
          fileName: 'entry.js',
          imports: [],
          dynamicImports: ['lazy.js'],
          isEntry: true,
          modules: {
            [entryModule]: {},
            [registrationResolvedId]: {},
            [runtimeResolvedId]: {},
          },
        },
        'lazy.js': {
          type: 'chunk',
          fileName: 'lazy.js',
          imports: [],
          modules: { [lazyModule]: {} },
        },
      },
      projectRoot,
      importsByModule: new Map([[lazyModule, [registrationPublicId]]]),
      moduleSourceByResolvedId,
      registrationDependenciesByResolvedId,
    })).not.toThrow();
  });

  it('accepts registration modules in a statically imported shared chunk', () => {
    expect(() => assertCssRegistrationBundleIntegrity({
      bundle: {
        'entry.js': {
          type: 'chunk',
          fileName: 'entry.js',
          imports: [],
          dynamicImports: ['lazy.js'],
          isEntry: true,
          modules: { [entryModule]: {} },
        },
        'lazy.js': {
          type: 'chunk',
          fileName: 'lazy.js',
          imports: ['./shared.js'],
          modules: { '/src/Lazy.vue?vue&type=script': {} },
        },
        'shared.js': {
          type: 'chunk',
          fileName: 'shared.js',
          imports: [],
          modules: {
            [registrationResolvedId]: {},
            [runtimeResolvedId]: {},
          },
        },
      },
      projectRoot,
      importsByModule: new Map([[lazyModule, [registrationPublicId]]]),
      moduleSourceByResolvedId,
      registrationDependenciesByResolvedId,
    })).not.toThrow();
  });

  it('does not treat another HTML entry as initial CSS for an unrelated owner graph', () => {
    expect(() => assertCssRegistrationBundleIntegrity({
      bundle: {
        'app.js': {
          type: 'chunk',
          fileName: 'app.js',
          imports: [],
          dynamicImports: ['lazy.js'],
          isEntry: true,
          modules: { [entryModule]: {} },
        },
        'broker.js': {
          type: 'chunk',
          fileName: 'broker.js',
          imports: [],
          isEntry: true,
          modules: {
            [registrationResolvedId]: {},
            [runtimeResolvedId]: {},
          },
        },
        'lazy.js': {
          type: 'chunk',
          fileName: 'lazy.js',
          imports: [],
          modules: { [lazyModule]: {} },
        },
      },
      projectRoot,
      importsByModule: new Map([[lazyModule, [registrationPublicId]]]),
      moduleSourceByResolvedId,
      registrationDependenciesByResolvedId,
    })).toThrow(/not loaded with their owners/u);
  });

  it('rejects registration modules that are emitted outside the owner load graph', () => {
    expect(() => assertCssRegistrationBundleIntegrity({
      bundle: bundleWith({
        includeRegistration: true,
        includeRuntime: true,
        registrationInOrphanChunk: true,
      }),
      projectRoot,
      importsByModule: new Map([[lazyModule, [registrationPublicId]]]),
      moduleSourceByResolvedId,
      registrationDependenciesByResolvedId,
    })).toThrow(/not loaded with their owners/u);
  });

  it('does not match an absolute module outside the project by a shared path suffix', () => {
    expect(() => assertCssRegistrationBundleIntegrity({
      bundle: {
        'entry.js': {
          type: 'chunk',
          fileName: 'entry.js',
          imports: [],
          dynamicImports: ['lazy.js'],
          isEntry: true,
          modules: { [entryModule]: {} },
        },
        'lazy.js': {
          type: 'chunk',
          fileName: 'lazy.js',
          imports: [],
          modules: {
            '/other-project/src/Lazy.vue': {},
            [registrationResolvedId]: {},
            [runtimeResolvedId]: {},
          },
        },
      },
      projectRoot,
      importsByModule: new Map([[lazyModule, [registrationPublicId]]]),
      moduleSourceByResolvedId,
      registrationDependenciesByResolvedId,
    })).toThrow(/unexpected registrations/u);
  });

  it('ignores planned registrations whose owner module was tree-shaken', () => {
    expect(() => assertCssRegistrationBundleIntegrity({
      bundle: {
        'entry.js': { type: 'chunk', modules: { [entryModule]: {} } },
      },
      projectRoot,
      importsByModule: new Map([[lazyModule, [registrationPublicId]]]),
      moduleSourceByResolvedId,
      registrationDependenciesByResolvedId,
    })).not.toThrow();
  });

  it('rejects registrations absent from the active plan and misplaced runtime modules', () => {
    expect(() => assertCssRegistrationBundleIntegrity({
      bundle: bundleWith({ includeRegistration: true, includeRuntime: true }),
      projectRoot,
      importsByModule: new Map([[lazyModule, [registrationPublicId]]]),
      moduleSourceByResolvedId: new Map(),
      registrationDependenciesByResolvedId,
    })).toThrow(/missing from the active plan/u);

    const bundle = bundleWith({ includeRegistration: true, includeRuntime: false });
    bundle['orphan-runtime.js'] = {
      type: 'chunk',
      fileName: 'orphan-runtime.js',
      imports: [],
      modules: { [runtimeResolvedId]: {} },
    };
    expect(() => assertCssRegistrationBundleIntegrity({
      bundle,
      projectRoot,
      importsByModule: new Map([[lazyModule, [registrationPublicId]]]),
      moduleSourceByResolvedId,
      registrationDependenciesByResolvedId,
    })).toThrow(/virtual:naidan-tailwind-css-runtime.*not loaded with lazy\.js/u);
  });

  it('rejects runtime emission when no retained registration requires it', () => {
    expect(() => assertCssRegistrationBundleIntegrity({
      bundle: {
        'entry.js': {
          type: 'chunk',
          fileName: 'entry.js',
          imports: [],
          isEntry: true,
          modules: { [entryModule]: {}, [runtimeResolvedId]: {} },
        },
      },
      projectRoot,
      importsByModule: new Map(),
      moduleSourceByResolvedId: new Map(),
      registrationDependenciesByResolvedId,
    })).toThrow(/runtime module emission count was 1, expected 0/u);
  });

  it('rejects missing, duplicated, and runtime-less production registrations', () => {
    expect(() => assertCssRegistrationBundleIntegrity({
      bundle: bundleWith({ includeRegistration: false, includeRuntime: false }),
      projectRoot,
      importsByModule: new Map([[lazyModule, [registrationPublicId]]]),
      moduleSourceByResolvedId,
      registrationDependenciesByResolvedId,
    })).toThrow(/missing registrations/u);

    expect(() => assertCssRegistrationBundleIntegrity({
      bundle: bundleWith({ includeRegistration: true, includeRuntime: true, duplicateRegistration: true }),
      projectRoot,
      importsByModule: new Map([[lazyModule, [registrationPublicId]]]),
      moduleSourceByResolvedId,
      registrationDependenciesByResolvedId,
    })).toThrow(/not emitted exactly once/u);

    expect(() => assertCssRegistrationBundleIntegrity({
      bundle: bundleWith({ includeRegistration: true, includeRuntime: false }),
      projectRoot,
      importsByModule: new Map([[lazyModule, [registrationPublicId]]]),
      moduleSourceByResolvedId,
      registrationDependenciesByResolvedId,
    })).toThrow(/runtime module emission count/u);
  });
});
