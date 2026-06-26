import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import vue from '@vitejs/plugin-vue';
import type { OutputAsset, OutputChunk, RolldownOutput } from 'rolldown';
import { afterEach, describe, expect, it } from 'vitest';
import { build, type PluginOption } from 'vite';

import { createBoundaryStringsPlugin } from './index';

const temporaryDirectories: string[] = [];
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

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('Boundary Strings Vite plugin', () => {
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
});
