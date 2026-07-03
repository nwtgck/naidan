import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createTwClassVitePlugin } from './tw-class-vite-plugin.mjs';

const temporaryDirectories: string[] = [];

type HookHandler<TArguments extends unknown[], TResult> = (...arguments_: TArguments) => TResult;

function getHookHandler<TArguments extends unknown[], TResult>({ hook, name }: {
  hook: unknown,
  name: string,
}): HookHandler<TArguments, TResult> {
  if (typeof hook === 'function') return hook as HookHandler<TArguments, TResult>;
  if (typeof hook === 'object' && hook !== null && 'handler' in hook && typeof hook.handler === 'function') {
    return hook.handler as HookHandler<TArguments, TResult>;
  }
  throw new TypeError(`Expected ${name} to be a callable Vite hook.`);
}

afterEach(() => {
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
    content: JSON.stringify({ devDependencies: { tailwindcss: '4.3.1' } }),
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

describe('static Tailwind Vite plugin build diagnostics', () => {
  it('removes stale debug output before build planning starts', async () => {
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
      aliases: [],
      additionalLazyRootDirectories: [],
      debugOutputDirectory,
      splitCss: false,
      cssPlanning: 'enabled',
      maxLazyCssGroups: undefined,
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
      aliases: [],
      additionalLazyRootDirectories: [],
      debugOutputDirectory: path.join(root, 'dist/debug-tailwind'),
      splitCss: true,
      cssPlanning: 'enabled',
      maxLazyCssGroups: undefined,
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
        hot: { send(message: unknown) {
          customMessages.push(message);
        } },
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
      data: { ids: expect.arrayContaining([`\0${privateA}`]) },
    });
    expect(reloads.length).toBeGreaterThan(0);
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
      aliases: [],
      additionalLazyRootDirectories: [],
      debugOutputDirectory: path.join(root, 'dist/debug-tailwind'),
      splitCss: false,
      cssPlanning: 'enabled',
      maxLazyCssGroups: undefined,
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
