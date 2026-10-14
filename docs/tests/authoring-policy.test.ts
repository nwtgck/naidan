import path from 'node:path';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { build, createServer } from 'vite';
import { validateDocsAuthoringSource } from '../build/authoring-policy';
import { docsBuildConfig } from '../build/production';
import { validateStaticComponent } from '../build/source-policy';
import { createDocsModulesPlugin } from '../build/virtual-modules';
import { createSiteFixture, startSiteDev } from './site.test-support';

const root = '/docs';

const resolve = async ({ specifier, importer }: { specifier: string; importer: string }): Promise<string | undefined> => {
  if (specifier === '@branching') return '/docs/islands/branching/BranchingDemo.vue';
  if (specifier.endsWith('/core')) return `${path.resolve(path.dirname(importer), specifier)}.ts`;
  if (specifier.startsWith('.')) {
    const resolved = path.resolve(path.dirname(importer), specifier);
    return path.extname(resolved) ? resolved : `${resolved}.ts`;
  }
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

  it('rejects browser lifecycle and watcher imports in static scripts with source locations', async () => {
    for (const name of ['onBeforeMount', 'onMounted', 'onBeforeUpdate', 'onUpdated', 'onBeforeUnmount', 'onUnmounted',
      'onActivated', 'onDeactivated', 'onRenderTracked', 'onRenderTriggered',
      'watch', 'watchEffect', 'watchPostEffect', 'watchSyncEffect']) {
      await expect(validate({
        filename: 'pages/test/index.vue',
        source: `<script setup lang="ts">\nimport { ${name} as callback } from 'vue';\n</script><template><p>Static</p></template>`,
      })).rejects.toThrow(new RegExp(`pages/test/index\\.vue:2:10: Vue ${name} `, 'u'));
    }
    await expect(validate({
      filename: 'site/helper.ts',
      source: "export { onMounted as afterRender } from 'vue';",
    })).rejects.toThrow('Vue onMounted is not called');
    await expect(validate({
      filename: 'islands/browser-ai-availability/copy.ts',
      source: "import { onMounted } from 'vue';",
    })).rejects.toThrow('Vue onMounted is not called');
    await expect(validate({
      filename: 'islands/branching/definition.ts',
      source: "import { onMounted } from 'vue';",
    })).rejects.toThrow('Vue onMounted is not called');
    await expect(validate({
      filename: 'islands/branching/contracts.ts',
      source: "import { onMounted } from 'vue';",
    })).rejects.toThrow('Vue onMounted is not called');
  });

  it('keeps server-rendered Vue APIs and island browser lifecycle available', async () => {
    await expect(validate({
      filename: 'pages/test/index.vue',
      source: `\
<script setup lang="ts">
import { computed, defineAsyncComponent, onErrorCaptured, onServerPrefetch, ref } from 'vue';
const count = ref(1);
const doubled = computed(() => count.value * 2);
const Child = defineAsyncComponent(() => import('../../site/demos/StaticDemo.vue'));
onServerPrefetch(async () => { count.value = 2; });
onErrorCaptured(() => false);
</script>
<template><Child />{{ doubled }}</template>`,
    })).resolves.toBeUndefined();
    await expect(validate({
      filename: 'islands/branching/BranchingDemo.vue',
      source: '<script setup lang="ts">import { onMounted, watch } from "vue"; onMounted(() => {}); watch(() => 1, () => {});</script><template><p>Island</p></template>',
    })).resolves.toBeUndefined();
    await expect(validate({ filename: 'server.ts', source: "import { h } from 'vue'; export const node = h('p', 'Static');" })).resolves.toBeUndefined();
  });

  it('limits static SFCs to inline setup and the current safe defineOptions form', async () => {
    await expect(validate({
      filename: 'site/DocsIsland.vue',
      source: '<script setup lang="ts">defineOptions({ inheritAttrs: false });</script><template><p>Host</p></template>',
    })).resolves.toBeUndefined();
    for (const source of [
      '<script>export default { mounted() {} };</script><template><p>Page</p></template>',
      '<script src="./client.ts"></script><template><p>Page</p></template>',
      '<script setup src="./client.ts"></script><template><p>Page</p></template>',
    ]) {
      await expect(validate({ filename: 'pages/test/index.vue', source })).rejects.toThrow(/pages\/test\/index\.vue:\d+:\d+: Static Docs/u);
    }
    for (const options of ['{ mounted() {} }', '{ inheritAttrs: true }', '{ inheritAttrs: false, mounted() {} }', '{ ...options }']) {
      await expect(validate({
        filename: 'pages/test/index.vue',
        source: `<script setup lang="ts">defineOptions(${options});</script><template><p>Page</p></template>`,
      })).rejects.toThrow('defineOptions supports only { inheritAttrs: false }');
    }
    await expect(validate({ filename: 'site/helper.ts', source: 'function defineOptions(value: object) { return value; } defineOptions({ mounted: true });' }))
      .resolves.toBeUndefined();
  });

  it('rejects Teleport, custom directives, and template refs only in static templates', () => {
    for (const tag of ['Teleport', 'teleport']) {
      expect(() => validateStaticComponent({
        source: `\
<template>
  <${tag} to="body"><p>Missing content</p></${tag}>
</template>`,
        filename: 'pages/test/index.vue',
        mode: 'static',
      })).toThrow(/pages\/test\/index\.vue:2:3: Teleport content is omitted/u);
    }
    expect(() => validateStaticComponent({
      source: `\
<script setup lang="ts">const vFocus = { mounted(el: HTMLElement) { el.focus(); } };</script>
<template>
  <input v-focus>
</template>`,
      filename: 'pages/test/index.vue',
      mode: 'static',
    })).toThrow(/pages\/test\/index\.vue:3:10: Directive v-focus is unsupported/u);
    for (const binding of ['ref="element"', ':ref="element"', 'v-bind:ref="element"']) {
      expect(() => validateStaticComponent({
        source: `\
<template>
  <p ${binding}>Heading</p>
</template>`,
        filename: 'pages/test/index.vue',
        mode: 'static',
      })).toThrow(/pages\/test\/index\.vue:2:6: Template refs are not populated/u);
    }
    expect(() => validateStaticComponent({
      source: '<template><div v-if="true" v-show="true" v-text="\'Static\'" /></template>',
      filename: 'pages/test/index.vue',
      mode: 'static',
    })).not.toThrow();
    expect(() => validateStaticComponent({
      source: '<template><Teleport to="body"><input v-focus ref="element"></Teleport></template>',
      filename: 'islands/branching/BranchingDemo.vue',
      mode: 'island',
    })).not.toThrow();
  });

  it('rejects Teleport and useTemplateRef value imports and re-exports in static authoring', async () => {
    for (const name of ['Teleport', 'useTemplateRef']) {
      await expect(validate({ filename: 'site/helper.ts', source: `import { ${name} as alias } from 'vue';` }))
        .rejects.toThrow(new RegExp(`site/helper\\.ts:1:\\d+: Vue ${name} `, 'u'));
      await expect(validate({ filename: 'site/helper.ts', source: `export { ${name} as alias } from 'vue';` }))
        .rejects.toThrow(new RegExp(`site/helper\\.ts:1:\\d+: Vue ${name} `, 'u'));
      await expect(validate({ filename: 'site/helper.ts', source: `import type { ${name} } from 'vue';` }))
        .resolves.toBeUndefined();
    }
    await expect(validate({
      filename: 'islands/branching/BranchingDemo.vue',
      source: '<script setup lang="ts">import { Teleport, useTemplateRef } from "vue";</script><template><Teleport to="body"><p>Island</p></Teleport></template>',
    })).resolves.toBeUndefined();
  });

  it.each([
    { name: 'Teleport', script: '', template: '<Teleport to="body"><p>Lost text</p></Teleport>', reason: 'Teleport content is omitted' },
    { name: 'custom directive', script: 'const vFocus = { mounted(el: HTMLElement) { el.focus(); } };', template: '<input v-focus>', reason: 'Directive v-focus is unsupported' },
    { name: 'template ref', script: "import { ref } from 'vue'; const element = ref<HTMLElement | null>(null);", template: '<p ref="element">Heading</p>', reason: 'Template refs are not populated' },
  ])('rejects $name in production and shows a recoverable development error', async ({ script, template, reason }) => {
    await using fixture = await createSiteFixture();
    const file = path.join(fixture.docs, 'pages/file-access/index.vue');
    const source = await readFile(file, 'utf8');
    const invalid = source.replace('<script setup lang="ts">', `<script setup lang="ts">\n${script}`)
      .replace('<template>', `<template>\n  ${template}`);
    expect(invalid).not.toBe(source);
    await writeFile(file, invalid);
    await expect(build({ ...docsBuildConfig({ root: fixture.docs }), configFile: false, logLevel: 'silent' }))
      .rejects.toThrow(reason);

    await using dev = await startSiteDev({ root: fixture.root });
    const failed = await dev.request({ url: '/docs/en/file-access/' });
    expect(failed.status).toBe(500);
    expect(failed.headers.get('content-type')).toContain('text/html');
    const details = await failed.text();
    expect(details).toContain('pages/file-access/index.vue');
    expect(details).toContain(reason);
    expect((await dev.request({ url: '/docs/en/chat-branching/' })).status).toBe(200);

    await writeFile(file, source);
    dev.server.watcher.emit('change', file);
    await expect.poll(async () => (await dev.request({ url: '/docs/en/file-access/' })).status)
      .toBe(200);
  }, 60_000);

  it('rejects unsupported Vue script syntax and render functions only in static authoring', async () => {
    for (const source of [
      "import * as Vue from 'vue'; Vue.onMounted(() => {});",
      "export * from 'vue';",
      "export * as Vue from 'vue';",
      "void import('vue');",
      "const Vue = require('vue');",
      "import { onMounted } from '@vue/runtime-core';",
      "export { watchEffect } from '@vue/runtime-dom';",
      "import { watch } from '@vue/reactivity';",
      "import { h } from 'vue';",
      "import { createVNode } from 'vue';",
      "import { defineComponent } from 'vue';",
    ]) {
      await expect(validate({ filename: 'site/helper.ts', source })).rejects.toThrow(/site\/helper\.ts:1:\d+:/u);
    }
    await expect(validate({ filename: 'site/helper.ts', source: "import type * as Vue from 'vue'; import type { VNode } from '@vue/runtime-core';" }))
      .resolves.toBeUndefined();
  });

  it('keeps static helpers out of browser client and private island code', async () => {
    await expect(validate({ filename: 'site/helper.ts', source: "export { start } from '../client/behavior.ts';" }))
      .rejects.toThrow('cannot import browser client code');
    await expect(validate({ filename: 'site/helper.ts', source: "import { wrapSearchWorker } from '../islands/search/transport.ts';" }))
      .rejects.toThrow('cannot import private island code');
    await expect(validate({ filename: 'site/helper.ts', source: "import type { Start } from '../client/behavior.ts';" }))
      .resolves.toBeUndefined();
    await expect(validate({ filename: 'site/helper.ts', source: "import { checkerCopy } from '../islands/browser-ai-availability/copy.ts';" }))
      .resolves.toBeUndefined();
    await expect(validate({ filename: 'site/helper.ts', source: "import { branchingIsland } from '../islands/branching/definition.ts';" }))
      .resolves.toBeUndefined();
    await expect(validate({
      filename: 'islands/branching/definition.ts',
      source: `\
import { defineDocsIsland } from '../core';
import { branchingSpec } from './contracts';
import BranchingDemo from './BranchingDemo.vue';
import { start } from '../search/transport.ts';
export const branchingIsland = defineDocsIsland({ spec: branchingSpec, component: BranchingDemo });`,
    })).rejects.toThrow('cannot import private island code');
    await expect(validate({
      filename: 'islands/branching/contracts.ts',
      source: `\
import { defineDocsIslandSpec } from '../spec';
import { start } from '../search/transport.ts';
export const branchingSpec = defineDocsIslandSpec({ id: 'branching', parse: () => ({}), start: 'interactive' });`,
    })).rejects.toThrow('cannot import private island code');
  });
});
