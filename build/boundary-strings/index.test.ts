import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import vue from '@vitejs/plugin-vue';
import type { OutputAsset, OutputChunk, RolldownOutput } from 'rolldown';
import { afterEach, describe, expect, it } from 'vitest';
import { build, createServer, type PluginOption, type ViteDevServer } from 'vite';

import { createBoundaryStringsPlugin } from './index';

const temporaryDirectories: string[] = [];
const fixtureServers: ViteDevServer[] = [];
const messageKey = 'Example__shared_message';

function writeFile({ filePath, source }: {
  filePath: string;
  source: string;
}): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, source);
}

function createFixtureRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'naidan-boundary-build-'));
  temporaryDirectories.push(root);

  for (const locale of ['en', 'ja']) {
    writeFile({
      filePath: path.join(root, `src/strings/catalogs/${locale}.ts`),
      source: `\
import { ${messageKey} } from '@/strings/messages/${messageKey}/${locale}';

export const ${locale} = {
  ${messageKey},
};
`,
    });
  }
  for (const locale of ['en', 'ja']) {
    writeFile({
      filePath: path.join(root, `src/strings/messages/${messageKey}/${locale}.ts`),
      source: `export const ${messageKey} = (): string => ${JSON.stringify(`${locale} message`)};\n`,
    });
  }
  writeFile({
    filePath: path.join(root, 'src/strings/index.ts'),
    source: `\
export const lazyStrings = new Proxy({}, {
  get() {
    return (): string => '';
  },
});
`,
  });
  writeFile({
    filePath: path.join(root, 'src/strings/runtime.ts'),
    source: `\
const registrations: unknown[] = [];

export function registerStringBoundary(args: unknown): void {
  registrations.push(args);
}
`,
  });
  return root;
}

function outputChunks({ output }: {
  output: RolldownOutput | readonly RolldownOutput[];
}): readonly OutputChunk[] {
  const outputs = Array.isArray(output) ? output : [output];
  return outputs.flatMap((result) => {
    return result.output.filter((item: OutputAsset | OutputChunk): item is OutputChunk => item.type === 'chunk');
  });
}

function staticChunkClosure({ chunks, entryFileName }: {
  chunks: readonly OutputChunk[];
  entryFileName: string;
}): ReadonlySet<string> {
  const chunksByFileName = new Map(chunks.map((chunk) => [chunk.fileName, chunk]));
  const visited = new Set<string>();
  const pending = [entryFileName];
  while (pending.length > 0) {
    const fileName = pending.pop();
    if (fileName === undefined || visited.has(fileName)) {
      continue;
    }
    visited.add(fileName);
    const chunk = chunksByFileName.get(fileName);
    if (chunk !== undefined) {
      pending.push(...chunk.imports);
    }
  }
  return visited;
}

async function buildFixture({ plugins, root }: {
  plugins: PluginOption[];
  root: string;
}): Promise<readonly OutputChunk[]> {
  const output = await build({
    configFile: false,
    logLevel: 'silent',
    plugins,
    resolve: {
      alias: {
        '@': path.join(root, 'src'),
        vue: path.resolve('node_modules/vue/dist/vue.runtime.esm-bundler.js'),
      },
    },
    root,
    build: {
      minify: false,
      write: false,
      rolldownOptions: {
        input: path.join(root, 'src/main.ts'),
      },
    },
  }) as RolldownOutput | readonly RolldownOutput[];
  return outputChunks({ output });
}

async function createFixtureServer({ root }: {
  root: string;
}): Promise<ViteDevServer> {
  const server = await createServer({
    configFile: false,
    logLevel: 'silent',
    plugins: createBoundaryStringsPlugin(),
    resolve: {
      alias: {
        '@': path.join(root, 'src'),
      },
    },
    root,
    server: {
      hmr: false,
      middlewareMode: true,
    },
  });
  fixtureServers.push(server);
  return server;
}

async function waitForWatcherEvent({ action, event, filePath, server }: {
  action: () => void;
  event: 'add' | 'change' | 'unlink';
  filePath: string;
  server: ViteDevServer;
}): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for ${event} on ${filePath}.`));
    }, 5_000);
    const handler = (changedPath: string): void => {
      if (path.resolve(changedPath) !== path.resolve(filePath)) {
        return;
      }
      cleanup();
      resolve();
    };
    const cleanup = (): void => {
      clearTimeout(timeout);
      server.watcher.off(event, handler);
    };
    server.watcher.on(event, handler);
    action();
  });
}

function writeCatalog({ keys, locale, root }: {
  keys: readonly string[];
  locale: 'en' | 'ja';
  root: string;
}): void {
  const imports = keys.map((key) => {
    return `import { ${key} } from '@/strings/messages/${key}/${locale}';`;
  }).join('\n');
  const entries = keys.map((key) => `  ${key},`).join('\n');
  writeFile({
    filePath: path.join(root, `src/strings/catalogs/${locale}.ts`),
    source: `\
${imports}${imports.length === 0 ? '' : '\n\n'}export const ${locale} = {
${entries}${entries.length === 0 ? '' : '\n'}};
`,
  });
}

async function closeFixtureServers(): Promise<void> {
  for (const server of fixtureServers.splice(0)) {
    await server.close();
  }
}

afterEach(async () => {
  await closeFixtureServers();
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('Boundary Strings Vite plugin', () => {
  it('creates stable boundary IDs across different checkout directories', async () => {
    const roots = [createFixtureRoot(), createFixtureRoot()];
    const boundaryModuleIds: string[][] = [];

    for (const root of roots) {
      writeFile({
        filePath: path.join(root, 'src/main.ts'),
        source: `\
import { lazyStrings } from '@/strings';

export const message = lazyStrings.${messageKey}();
`,
      });
      const chunks = await buildFixture({
        plugins: createBoundaryStringsPlugin(),
        root,
      });
      boundaryModuleIds.push(chunks.flatMap((chunk) => {
        return Object.keys(chunk.modules).filter((moduleId) => {
          return moduleId.startsWith('\0virtual:naidan-boundary-strings/boundary/');
        });
      }).sort());
    }

    expect(boundaryModuleIds[0]).toEqual(boundaryModuleIds[1]);
  });

  it('keeps root-boundary locale implementations out of the initial static graph', async () => {
    const root = createFixtureRoot();
    writeFile({
      filePath: path.join(root, 'src/main.ts'),
      source: `\
import { lazyStrings } from '@/strings';

export const message = lazyStrings.${messageKey}();
`,
    });

    const chunks = await buildFixture({
      plugins: createBoundaryStringsPlugin(),
      root,
    });
    const entry = chunks.find((chunk) => chunk.isEntry);
    expect(entry).toBeDefined();
    const staticFiles = staticChunkClosure({
      chunks,
      entryFileName: entry?.fileName ?? '',
    });
    const staticModuleIds = chunks
      .filter((chunk) => staticFiles.has(chunk.fileName))
      .flatMap((chunk) => Object.keys(chunk.modules));

    expect(staticModuleIds.some((moduleId) => {
      return moduleId.startsWith('\0virtual:naidan-boundary-strings/boundary/');
    })).toBe(true);
    expect(staticModuleIds.some((moduleId) => {
      return moduleId.startsWith('\0virtual:naidan-boundary-strings/pack/');
    })).toBe(false);
    expect(staticModuleIds.some((moduleId) => {
      return moduleId.replaceAll('\\', '/').includes('/src/strings/messages/');
    })).toBe(false);
  });

  it('emits one locale implementation module when two lazy boundaries use the same message', async () => {
    const root = createFixtureRoot();
    writeFile({
      filePath: path.join(root, 'src/main.ts'),
      source: `\
void import('./first');
void import('./second');
`,
    });
    for (const moduleName of ['first', 'second']) {
      writeFile({
        filePath: path.join(root, `src/${moduleName}.ts`),
        source: `\
import { lazyStrings } from '@/strings';

export const message = lazyStrings.${messageKey}();
`,
      });
    }

    const chunks = await buildFixture({
      plugins: createBoundaryStringsPlugin(),
      root,
    });
    const moduleIds = chunks.flatMap((chunk) => Object.keys(chunk.modules));

    for (const locale of ['en', 'ja']) {
      const suffix = `/src/strings/messages/${messageKey}/${locale}.ts`;
      expect(moduleIds.filter((moduleId) => moduleId.replaceAll('\\', '/').endsWith(suffix))).toHaveLength(1);
    }
    expect(moduleIds.filter((moduleId) => {
      return moduleId.startsWith('\0virtual:naidan-boundary-strings/boundary/');
    })).toHaveLength(2);
  });

  it('does not treat a sibling path sharing the root prefix as a project module', async () => {
    const root = createFixtureRoot();
    const outsideRoot = `${root}-outside`;
    temporaryDirectories.push(outsideRoot);
    writeFile({
      filePath: path.join(root, 'src/main.ts'),
      source: `import ${JSON.stringify(path.join(outsideRoot, 'external.ts'))};\n`,
    });
    writeFile({
      filePath: path.join(outsideRoot, 'external.ts'),
      source: `\
import { lazyStrings } from '@/strings';

export const message = lazyStrings.${messageKey}();
`,
    });

    const chunks = await buildFixture({
      plugins: createBoundaryStringsPlugin(),
      root,
    });
    const moduleIds = chunks.flatMap((chunk) => Object.keys(chunk.modules));

    expect(moduleIds.filter((moduleId) => {
      return moduleId.startsWith('\0virtual:naidan-boundary-strings/boundary/');
    })).toHaveLength(0);
  });

  it('injects a boundary into compiled Vue JavaScript without rewriting raw SFC tags', async () => {
    const root = createFixtureRoot();
    writeFile({
      filePath: path.join(root, 'src/main.ts'),
      source: `\
import './Example.vue';
`,
    });
    writeFile({
      filePath: path.join(root, 'src/Example.vue'),
      source: `\
<!-- <script setup lang="ts">lazyStrings.Example__fake()</script> -->
<script generic="T" lang="ts" setup>
import { lazyStrings } from '@/strings';
</script>

<template>
  <p>{{ lazyStrings.Example__shared_message() }}</p>
</template>
`,
    });

    const chunks = await buildFixture({
      plugins: [
        ...createBoundaryStringsPlugin(),
        vue(),
      ],
      root,
    });
    const moduleIds = chunks.flatMap((chunk) => Object.keys(chunk.modules));

    expect(moduleIds.some((moduleId) => {
      return moduleId.startsWith('\0virtual:naidan-boundary-strings/boundary/');
    })).toBe(true);
    expect(moduleIds.some((moduleId) => {
      return moduleId.replaceAll('\\', '/').endsWith(`/src/strings/messages/${messageKey}/en.ts`);
    })).toBe(true);
  });

  it('refreshes a stale catalog in the same HMR-disabled server after adding a key', async () => {
    const root = createFixtureRoot();
    const nextMessageKey = 'Example__new_watch_message';
    const mainPath = path.join(root, 'src/main.ts');
    writeFile({
      filePath: mainPath,
      source: `\
import { lazyStrings } from '@/strings';

export const message = lazyStrings.${messageKey}();
`,
    });
    const server = await createFixtureServer({ root });

    await expect(server.transformRequest('/src/main.ts')).resolves.toBeDefined();

    for (const locale of ['en', 'ja'] as const) {
      writeFile({
        filePath: path.join(root, `src/strings/messages/${nextMessageKey}/${locale}.ts`),
        source: `export const ${nextMessageKey} = (): string => ${JSON.stringify(`${locale} next`)};\n`,
      });
      writeCatalog({ keys: [messageKey, nextMessageKey], locale, root });
    }
    await waitForWatcherEvent({
      action: () => {
        writeFile({
          filePath: mainPath,
          source: `\
import { lazyStrings } from '@/strings';

export const message = lazyStrings.${nextMessageKey}();
`,
        });
      },
      event: 'change',
      filePath: mainPath,
      server,
    });

    const transformed = await server.transformRequest('/src/main.ts');
    expect(transformed?.code).toContain('virtual:naidan-boundary-strings/boundary/');
  });

  it('recovers after a source references a key before its catalog and message files exist', async () => {
    const root = createFixtureRoot();
    const nextMessageKey = 'Example__source_first_message';
    writeFile({
      filePath: path.join(root, 'src/main.ts'),
      source: `\
import { lazyStrings } from '@/strings';

export const message = lazyStrings.${nextMessageKey}();
`,
    });
    const server = await createFixtureServer({ root });

    await expect(server.transformRequest('/src/main.ts')).rejects.toThrow(
      `Unknown message key "${nextMessageKey}"`,
    );

    for (const locale of ['en', 'ja'] as const) {
      writeFile({
        filePath: path.join(root, `src/strings/messages/${nextMessageKey}/${locale}.ts`),
        source: `export const ${nextMessageKey} = (): string => ${JSON.stringify(`${locale} next`)};\n`,
      });
    }
    writeCatalog({ keys: [messageKey, nextMessageKey], locale: 'en', root });
    const japaneseCatalogPath = path.join(root, 'src/strings/catalogs/ja.ts');
    await waitForWatcherEvent({
      action: () => {
        writeCatalog({ keys: [messageKey, nextMessageKey], locale: 'ja', root });
      },
      event: 'change',
      filePath: japaneseCatalogPath,
      server,
    });

    const transformed = await server.transformRequest('/src/main.ts');
    expect(transformed?.code).toContain('virtual:naidan-boundary-strings/boundary/');
  });

  it('invalidates a source module when a watched catalog removes its key', async () => {
    const root = createFixtureRoot();
    const mainPath = path.join(root, 'src/main.ts');
    writeFile({
      filePath: mainPath,
      source: `\
import { lazyStrings } from '@/strings';

export const message = lazyStrings.${messageKey}();
`,
    });
    const server = await createFixtureServer({ root });

    await expect(server.transformRequest('/src/main.ts')).resolves.toBeDefined();

    fs.rmSync(path.join(root, 'src/strings/messages', messageKey), {
      force: true,
      recursive: true,
    });
    await waitForWatcherEvent({
      action: () => {
        writeCatalog({ keys: [], locale: 'en', root });
        writeCatalog({ keys: [], locale: 'ja', root });
      },
      event: 'change',
      filePath: path.join(root, 'src/strings/catalogs/ja.ts'),
      server,
    });

    await expect(server.transformRequest('/src/main.ts')).rejects.toThrow(
      `Unknown message key "${messageKey}"`,
    );
  });

  it('does not refresh a stale catalog for a source without Boundary Strings', async () => {
    const root = createFixtureRoot();
    const mainPath = path.join(root, 'src/main.ts');
    const englishCatalogPath = path.join(root, 'src/strings/catalogs/en.ts');
    writeFile({
      filePath: mainPath,
      source: `\
import { lazyStrings } from '@/strings';

export const value = 1;
`,
    });
    const server = await createFixtureServer({ root });

    await expect(server.transformRequest('/src/main.ts')).resolves.toBeDefined();

    await waitForWatcherEvent({
      action: () => {
        writeCatalog({
          keys: [messageKey, 'Example__temporarily_incomplete'],
          locale: 'en',
          root,
        });
      },
      event: 'change',
      filePath: englishCatalogPath,
      server,
    });
    await waitForWatcherEvent({
      action: () => {
        writeFile({
          filePath: mainPath,
          source: `\
import { lazyStrings } from '@/strings';

export const value = 2;
`,
        });
      },
      event: 'change',
      filePath: mainPath,
      server,
    });

    await expect(server.transformRequest('/src/main.ts')).resolves.toBeDefined();
  });

});
