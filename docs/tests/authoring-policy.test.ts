import path from 'node:path';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { createServer } from 'vite';
import { validateDocsAuthoringSource } from '../build/authoring-policy';
import { validateStaticComponent } from '../build/source-policy';
import { createDocsModulesPlugin } from '../build/virtual-modules';

const root = '/docs';

const resolve = async ({ specifier, importer }: { specifier: string; importer: string }): Promise<string | undefined> => {
  if (specifier === '@branching') return '/docs/islands/branching/BranchingDemo.vue';
  if (specifier.endsWith('/core')) return `${path.resolve(path.dirname(importer), specifier)}.ts`;
  if (specifier.startsWith('.')) return path.resolve(path.dirname(importer), specifier);
  return undefined;
};

async function validate({ source, filename }: { source: string; filename: string }): Promise<void> {
  await validateDocsAuthoringSource({ source, filename, root, resolve });
}

describe('Docs island authoring policy', () => {
  it('checks an authored helper outside site, pages, and islands during Vite transform', async () => {
    const fixture = await mkdtemp(path.join(tmpdir(), 'docs-authoring-'));
    try {
      await mkdir(path.join(fixture, 'client'));
      await mkdir(path.join(fixture, 'islands/branching'), { recursive: true });
      await writeFile(path.join(fixture, 'client/raw-helper.ts'), "export { default as Raw } from '../islands/branching/BranchingDemo.vue';");
      await writeFile(path.join(fixture, 'islands/branching/BranchingDemo.vue'), '<template><button @click="run">Run</button></template>');
      const server = await createServer({
        configFile: false,
        root: fixture,
        plugins: [createDocsModulesPlugin({ root: fixture })],
        server: { middlewareMode: true, hmr: false },
      });
      try {
        await expect(server.transformRequest('/client/raw-helper.ts')).rejects.toThrow('Import raw Docs island component');
      } finally {
        await server.close();
      }
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });

  it('rejects direct, aliased, re-exported, and literal async imports of raw island components', async () => {
    await expect(validate({
      filename: 'pages/test/index.vue',
      source: `\
<script setup lang="ts">import Demo from '../../islands/branching/BranchingDemo.vue';</script>
<template><Demo /></template>`,
    })).rejects.toThrow('Import raw Docs island component');
    await expect(validate({ filename: 'site/alias.ts', source: "export { default as Demo } from '@branching';" })).rejects.toThrow('Import raw Docs island component');
    await expect(validate({ filename: 'site/barrel.ts', source: "export * from '../islands/branching/BranchingDemo.vue';" })).rejects.toThrow('Import raw Docs island component');
    await expect(validate({
      filename: 'pages/test/index.vue',
      source: `\
<script setup lang="ts">import { defineAsyncComponent } from 'vue'; const Demo = defineAsyncComponent(() => import('../../islands/branching/BranchingDemo.vue'));</script>
<template><Demo /></template>`,
    })).rejects.toThrow('Import raw Docs island component');
  });

  it('allows concrete local component imports in a definition and ordinary async static components', async () => {
    await expect(validate({
      filename: 'islands/branching/definition.ts',
      source: `\
import { defineDocsIsland } from '../core';
import { branchingSpec } from './contracts';
import BranchingDemo from './BranchingDemo.vue';
export const branchingIsland = defineDocsIsland({ spec: branchingSpec, component: BranchingDemo });`,
    })).resolves.toBeUndefined();
    await expect(validate({
      filename: 'pages/test/index.vue',
      source: `\
<script setup lang="ts">import { defineAsyncComponent, computed, ref } from 'vue'; const n = ref(1); const result = computed(() => n.value + 1); const Demo = defineAsyncComponent(() => import('../../site/demos/StaticDemo.vue'));</script>
<template><Demo />{{ result }}</template>`,
    })).resolves.toBeUndefined();
  });

  it('rejects widened or indirect component and spec values in definitions', async () => {
    for (const component of ['Child as Generic', 'getChild()', 'Other']) {
      await expect(validate({
        filename: 'islands/branching/definition.ts',
        source: `\
import { defineDocsIsland } from '../core';
import { branchingSpec } from './contracts';
import Child from './BranchingDemo.vue';
const Other = Child;
export const island = defineDocsIsland({ spec: branchingSpec, component: ${component} });`,
      })).rejects.toThrow('directly imported component and spec');
    }
    await expect(validate({
      filename: 'islands/branching/definition.ts',
      source: `\
import { defineDocsIsland } from '../core';
import { branchingSpec } from '../search/contracts';
import Child from './BranchingDemo.vue';
export const island = defineDocsIsland({ spec: branchingSpec, component: Child });`,
    })).rejects.toThrow('local spec');
    await expect(validate({
      filename: 'islands/branching/contracts.ts',
      source: `\
import { defineDocsIslandSpec } from '../spec';
export const spec = defineDocsIslandSpec({ id: 'search', parse: x => x, start: 'immediate' });`,
    })).rejects.toThrow('ID must match');
  });

  it('exports only the opaque factory from a definition', async () => {
    const definition = `\
import { defineDocsIsland } from '../core';
import { branchingSpec } from './contracts';
import BranchingDemo from './BranchingDemo.vue';
export type DefinitionKind = 'branching';
export const branchingIsland = defineDocsIsland({ spec: branchingSpec, component: BranchingDemo });`;
    await expect(validate({ filename: 'islands/branching/definition.ts', source: definition })).resolves.toBeUndefined();
    await expect(validate({ filename: 'islands/branching/definition.ts', source: `${definition}\nexport function raw() { return BranchingDemo; }` }))
      .rejects.toThrow('may export only its factory');
    await expect(validate({ filename: 'islands/branching/definition.ts', source: `${definition}\nexport class Raw { component = BranchingDemo; }` }))
      .rejects.toThrow('may export only its factory');
  });

  it('keeps the island runtime reader behind the shared host', async () => {
    await expect(validate({
      filename: 'pages/test/index.vue',
      source: '<script setup lang="ts">import { readDocsIslandEntry } from "../../islands/core";</script><template><p>Page</p></template>',
    })).rejects.toThrow('Import Docs island runtime');
    await expect(validate({ filename: 'client/raw-helper.ts', source: "export { readDocsIslandEntry as raw } from '../islands/core';" }))
      .rejects.toThrow('Import Docs island runtime');
    await expect(validate({ filename: 'site/types.ts', source: "import type { DocsIslandEntry } from '../islands/core';" })).resolves.toBeUndefined();
    await expect(validate({
      filename: 'site/DocsIsland.vue',
      source: '<script setup lang="ts">import { readDocsIslandEntry } from "../islands/core"; import type { DocsIslandEntry } from "../islands/core";</script>',
    })).resolves.toBeUndefined();
  });

  it('rejects hand-written markers and additional DocsIsland attributes or slots', () => {
    for (const source of [
      '<template><div data-docs-island="branching" /></template>',
      '<template><div :data-docs-props="payload" /></template>',
      '<template><DocsIsland :entry="entry" class="extra" /></template>',
      '<template><DocsIsland :entry="entry"><b>slot</b></DocsIsland></template>',
      '<template><docs-island :entry="entry" data-extra="bad" /></template>',
    ]) {
      expect(() => validateStaticComponent({ source, filename: 'pages/test/index.vue', mode: 'static' })).toThrow();
    }
    expect(() => validateStaticComponent({ source: '<template><DocsIsland :entry="entry" /></template>', filename: 'pages/test/index.vue', mode: 'static' })).not.toThrow();
    const host = '<template><div :data-docs-island="data.id" :data-docs-props="data.serialized"><component :is="data.component" v-bind="data.canonical" /></div></template>';
    expect(() => validateStaticComponent({ source: host, filename: 'site/DocsIsland.vue', mode: 'static' })).not.toThrow();
    expect(() => validateStaticComponent({ source: '<template><component :is="data.component" v-bind="data.canonical" /></template>', filename: 'site/Other.vue', mode: 'static' })).toThrow('explicit static attribute name');
  });

  it('rejects obvious render-function markers and Vue context APIs', async () => {
    await expect(validate({ filename: 'site/render.ts', source: 'const props = { "data-docs-island": "branching" };' })).rejects.toThrow('Reserved Docs island attribute');
    await expect(validate({
      filename: 'islands/branching/BranchingDemo.vue',
      source: `\
<script setup lang="ts">import { useId as allocate } from 'vue'; const id = allocate();</script>
<template><p>{{ id }}</p></template>`,
    })).rejects.toThrow('Vue context API');
    await expect(validate({
      filename: 'islands/branching/BranchingDemo.vue',
      source: `\
<script setup lang="ts">import * as Vue from 'vue'; Vue.provide('x', 1);</script>
<template><p>Demo</p></template>`,
    })).rejects.toThrow('Vue context API');
  });
});
