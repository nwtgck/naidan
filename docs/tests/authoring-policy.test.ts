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
  if (specifier === '@branching') {
    return '/docs/islands/branching/BranchingDemo.vue';
  }
  if (specifier.endsWith('/core')) {
    return `${path.resolve(path.dirname(importer), specifier)}.ts`;
  }
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
    await expect(validate({ filename: 'components/alias.ts', source: "export { default as Demo } from '@branching';" })).rejects.toThrow('Import raw Docs island component');
    await expect(validate({ filename: 'components/barrel.ts', source: "export * from '../islands/branching/BranchingDemo.vue';" })).rejects.toThrow('Import raw Docs island component');
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
export const branchingIsland = defineDocsIsland({ spec: branchingSpec, component: BranchingDemo, prepare: () => undefined });`,
    })).resolves.toBeUndefined();
    await expect(validate({
      filename: 'pages/test/index.vue',
      source: `\
<script setup lang="ts">import { defineAsyncComponent, computed, ref } from 'vue'; const n = ref(1); const result = computed(() => n.value + 1); const Demo = defineAsyncComponent(() => import('../../components/demos/StaticDemo.vue'));</script>
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
export const island = defineDocsIsland({ spec: branchingSpec, component: ${component}, prepare: () => undefined });`,
      })).rejects.toThrow('directly imported component and spec');
    }
    await expect(validate({
      filename: 'islands/branching/definition.ts',
      source: `\
import { defineDocsIsland } from '../core';
import { branchingSpec } from '../search/contracts';
import Child from './BranchingDemo.vue';
export const island = defineDocsIsland({ spec: branchingSpec, component: Child, prepare: () => undefined });`,
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
export const branchingIsland = defineDocsIsland({ spec: branchingSpec, component: BranchingDemo, prepare: () => undefined });`;
    await expect(validate({ filename: 'islands/branching/definition.ts', source: definition })).resolves.toBeUndefined();
    await expect(validate({ filename: 'islands/branching/definition.ts', source: `${definition}\nexport function raw() { return BranchingDemo; }` }))
      .rejects.toThrow('may export only its factory');
    await expect(validate({ filename: 'islands/branching/definition.ts', source: `${definition}\nexport class Raw { component = BranchingDemo; }` }))
      .rejects.toThrow('may export only its factory');
  });

  it('requires prepare and permits only the definition own island message loader', async () => {
    await expect(validate({
      filename: 'islands/branching/definition.ts',
      source: `\
import { defineDocsIsland } from '../core';
import { branchingSpec } from './contracts';
import BranchingDemo from './BranchingDemo.vue';
import { prepareBranching } from './messages/index.ts';
export const branchingIsland = defineDocsIsland({ spec: branchingSpec, component: BranchingDemo, prepare: prepareBranching });`,
    })).resolves.toBeUndefined();
    await expect(validate({
      filename: 'islands/branching/definition.ts',
      source: `\
import { defineDocsIsland } from '../core';
import { branchingSpec } from './contracts';
import BranchingDemo from './BranchingDemo.vue';
export const branchingIsland = defineDocsIsland({ spec: branchingSpec, component: BranchingDemo });`,
    })).rejects.toThrow('with prepare');
    await expect(validate({
      filename: 'islands/branching/definition.ts',
      source: `\
import { defineDocsIsland } from '../core';
import { branchingSpec } from './contracts';
import BranchingDemo from './BranchingDemo.vue';
import { prepareOther } from '../search/messages.ts';
export const branchingIsland = defineDocsIsland({ spec: branchingSpec, component: BranchingDemo, prepare: prepareOther });`,
    })).rejects.toThrow('cannot import private island code');
    await expect(validate({
      filename: 'islands/branching/definition.ts',
      source: `\
import { defineDocsIsland } from '../core';
import { branchingSpec } from './contracts';
import BranchingDemo from './BranchingDemo.vue';
import { messages } from '../../pages/chat-branching/messages/en.tsx';
export const branchingIsland = defineDocsIsland({ spec: branchingSpec, component: BranchingDemo, prepare: () => messages });`,
    })).rejects.toThrow('server registry only');
  });

  it('keeps the island runtime reader behind the shared host', async () => {
    await expect(validate({
      filename: 'pages/test/index.vue',
      source: '<script setup lang="ts">import { readDocsIslandEntry } from "../../islands/core";</script><template><p>Page</p></template>',
    })).rejects.toThrow('Import Docs island runtime');
    await expect(validate({ filename: 'client/raw-helper.ts', source: "export { readDocsIslandEntry as raw } from '../islands/core';" }))
      .rejects.toThrow('Import Docs island runtime');
    await expect(validate({ filename: 'components/types.ts', source: "import type { DocsIslandEntry } from '../islands/core';" })).resolves.toBeUndefined();
    await expect(validate({
      filename: 'components/DocsIsland.vue',
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
    const host = '<template><div :data-docs-island="data.id" :data-docs-props="data.serialized"><component :is="preparedComponent()" v-bind="data.canonical" /></div></template>';
    expect(() => validateStaticComponent({ source: host, filename: 'components/DocsIsland.vue', mode: 'static' })).not.toThrow();
    expect(() => validateStaticComponent({ source: host.replace('preparedComponent()', 'data.component'), filename: 'components/DocsIsland.vue', mode: 'static' }))
      .toThrow('require explicit native tag literals');
    expect(() => validateStaticComponent({ source: '<template><component :is="data.component" v-bind="data.canonical" /></template>', filename: 'components/Other.vue', mode: 'static' })).toThrow('require explicit native tag literals');
  });

  it('rejects obvious render-function markers and Vue context APIs', async () => {
    await expect(validate({ filename: 'components/render.ts', source: 'const props = { "data-docs-island": "branching" };' })).rejects.toThrow('Reserved Docs island attribute');
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
      filename: 'components/helper.ts',
      source: "export { onMounted as afterRender } from 'vue';",
    })).rejects.toThrow('Vue onMounted is not called');
    await expect(validate({
      filename: 'islands/browser-ai-availability/messages/en.ts',
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
const Child = defineAsyncComponent(() => import('../../components/demos/StaticDemo.vue'));
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
      filename: 'components/DocsIsland.vue',
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
    await expect(validate({ filename: 'components/helper.ts', source: 'function defineOptions(value: object) { return value; } defineOptions({ mounted: true });' }))
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
      await expect(validate({ filename: 'components/helper.ts', source: `import { ${name} as alias } from 'vue';` }))
        .rejects.toThrow(new RegExp(`components/helper\\.ts:1:\\d+: Vue ${name} `, 'u'));
      await expect(validate({ filename: 'components/helper.ts', source: `export { ${name} as alias } from 'vue';` }))
        .rejects.toThrow(new RegExp(`components/helper\\.ts:1:\\d+: Vue ${name} `, 'u'));
      await expect(validate({ filename: 'components/helper.ts', source: `import type { ${name} } from 'vue';` }))
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
      await expect(validate({ filename: 'components/helper.ts', source })).rejects.toThrow(/components\/helper\.ts:1:\d+:/u);
    }
    await expect(validate({ filename: 'components/helper.ts', source: "import type * as Vue from 'vue'; import type { VNode } from '@vue/runtime-core';" }))
      .resolves.toBeUndefined();
  });

  it('rejects inactive click handlers hidden behind createElementVNode in a static component', async () => {
    await expect(validate({
      filename: 'pages/test/index.vue',
      source: `\
<script setup lang="ts">
import { createElementVNode, ref } from 'vue';
const count = ref(0);
const Counter = () => createElementVNode('button', { onClick: () => { count.value += 1; } }, String(count.value));
</script>
<template><Counter /></template>`,
    })).rejects.toThrow('Vue createElementVNode is outside the supported static Docs script subset; render functions can hide inactive events');
  });

  it('rejects unchecked links hidden behind createStaticVNode in a static component', async () => {
    await expect(validate({
      filename: 'pages/test/index.vue',
      source: `\
<script setup lang="ts">
import { createStaticVNode } from 'vue';
const UncheckedLink = () => createStaticVNode('<a href="/docs/en/missing-page/">Missing</a>', 1);
</script>
<template><UncheckedLink /></template>`,
    })).rejects.toThrow('Vue createStaticVNode is outside the supported static Docs script subset; render functions can hide inactive events');
  });

  it('rejects unchecked inline Vue options templates in a static component', async () => {
    await expect(validate({
      filename: 'pages/test/index.vue',
      source: `\
<script setup lang="ts">
const UncheckedLink = { template: '<a href="/docs/en/missing-page/">Missing</a>' };
</script>
<template><UncheckedLink /></template>`,
    })).rejects.toThrow('Static Docs scripts do not support object template properties');
  });

  it.each([
    "{ 'template': markup }",
    "{ ['template']: markup }",
    "{ [('template')]: markup }",
    '{ [`template`]: markup }',
    '{ template }',
    '{ get template() { return markup; } }',
    '{ template() { return markup; } }',
  ])('rejects equivalent inline template members in static helpers: %s', options => {
    return expect(validate({
      filename: 'components/helper.ts',
      source: `const markup = '<a href="/docs/en/missing-page/">Missing</a>'; const template = markup; export const options = ${options};`,
    })).rejects.toThrow('Static Docs scripts do not support object template properties');
  });

  it('keeps template data in locale catalogs and island contracts, and permits island component templates', async () => {
    for (const filename of ['messages/example/en.ts', 'pages/test/messages/en.tsx', 'islands/branching/messages/en.tsx']) {
      await expect(validate({ filename, source: "export const messages = { template: 'Choose a template' };" }))
        .resolves.toBeUndefined();
    }
    await expect(validate({
      filename: 'islands/branching/contracts.ts',
      source: "const payload = { template: 'A saved template' }; export const spec = defineDocsIslandSpec({ id: 'branching', parse: () => payload, start: 'dom-content-loaded' });",
    })).resolves.toBeUndefined();
    await expect(validate({
      filename: 'islands/branching/BranchingDemo.vue',
      source: '<script setup lang="ts">const Child = { template: \'<button @click="run">Run</button>\' };</script><template><Child /></template>',
    })).resolves.toBeUndefined();
  });

  it.each(['createElementVNode', 'createBlock', 'createElementBlock', 'cloneVNode', 'createStaticVNode'])('checks %s aliases and re-exports without restricting island render APIs or type imports', async name => {
    for (const source of [`import { ${name} as render } from 'vue';`, `export { ${name} as render } from 'vue';`]) {
      await expect(validate({ filename: 'components/helper.ts', source }))
        .rejects.toThrow(`Vue ${name} is outside the supported static Docs script subset; render functions can hide inactive events`);
    }
    await expect(validate({ filename: 'components/helper.ts', source: `import type { ${name} } from 'vue';` }))
      .resolves.toBeUndefined();
    await expect(validate({
      filename: 'islands/branching/BranchingDemo.vue',
      source: `<script setup lang="ts">import { ${name} } from 'vue';</script><template><p>Island</p></template>`,
    })).resolves.toBeUndefined();
  });

  it('keeps static helpers out of browser client and private island code', async () => {
    await expect(validate({ filename: 'components/helper.ts', source: "export { start } from '../client/behavior.ts';" }))
      .rejects.toThrow('cannot import browser client code');
    await expect(validate({ filename: 'components/helper.ts', source: "import { wrapSearchWorker } from '../islands/search/transport.ts';" }))
      .rejects.toThrow('cannot import private island code');
    await expect(validate({ filename: 'components/helper.ts', source: "import type { Start } from '../client/behavior.ts';" }))
      .resolves.toBeUndefined();
    await expect(validate({ filename: 'components/helper.ts', source: "import { en } from '../islands/browser-ai-availability/messages/en.ts';" }))
      .rejects.toThrow('cannot import private island code');
    await expect(validate({ filename: 'islands/browser-ai-availability/messages/index.ts', source: "import { en } from './en'; import { ja } from './ja'; export const messages = { en, ja };" }))
      .resolves.toBeUndefined();
    await expect(validate({ filename: 'components/helper.ts', source: "import { branchingIsland } from '../islands/branching/definition.ts';" }))
      .resolves.toBeUndefined();
    await expect(validate({
      filename: 'islands/branching/definition.ts',
      source: `\
import { defineDocsIsland } from '../core';
import { branchingSpec } from './contracts';
import BranchingDemo from './BranchingDemo.vue';
import { start } from '../search/transport.ts';
export const branchingIsland = defineDocsIsland({ spec: branchingSpec, component: BranchingDemo, prepare: () => undefined });`,
    })).rejects.toThrow('cannot import private island code');
    await expect(validate({
      filename: 'islands/branching/contracts.ts',
      source: `\
import { defineDocsIslandSpec } from '../spec';
import { start } from '../search/transport.ts';
export const branchingSpec = defineDocsIslandSpec({ id: 'branching', parse: () => ({}), start: 'interactive' });`,
    })).rejects.toThrow('cannot import private island code');
  });

  it('allows article locale JSX with inline markup and approved typed component imports', async () => {
    await expect(validate({
      filename: 'pages/test/messages/en.tsx',
      source: `\
import Guide from '../../../components/DocsLink.vue';
import UiLabel from '../../../components/UiLabel.vue';
export const messages = {
  body: () => <>Read <Guide locale="en" page="index">the guide</Guide>, then choose <UiLabel text="Save" />. <strong>Done.</strong><br /></>,
};`,
    })).resolves.toBeUndefined();
    await expect(validate({
      filename: 'components/RenderText.ts',
      source: "import type { VNode } from 'vue'; export function RenderText({ node }: { node: VNode }): VNode { return node; }",
    })).resolves.toBeUndefined();
    await expect(validate({
      filename: 'pages/test/messages/ja.tsx',
      source: "export const messages = { title: '案内', body: () => <strong>案内</strong> } satisfies typeof import('./en').messages;",
    })).resolves.toBeUndefined();
  });

  it.each([
    { name: 'native anchor', jsx: '<a href="/docs/">Guide</a>', reason: 'typed Docs link' },
    { name: 'active element', jsx: '<script />', reason: 'Unsupported static Docs rich JSX element' },
    { name: 'interactive element', jsx: '<button>Open</button>', reason: 'Unsupported static Docs rich JSX element' },
    { name: 'Teleport', jsx: '<Teleport to="body">Lost</Teleport>', reason: 'Unsupported static Docs rich JSX element' },
    { name: 'event attribute', jsx: '<span onClick={click}>Open</span>', reason: 'attribute onclick' },
    { name: 'directive attribute', jsx: '<span v-html={html}>Text</span>', reason: 'attribute v-html' },
    { name: 'camel-case directive', jsx: '<span vHtml={html}>Text</span>', reason: 'attribute vhtml' },
    { name: 'template ref', jsx: '<span ref={target}>Text</span>', reason: 'attribute ref' },
    { name: 'innerHTML', jsx: '<span innerHTML={html} />', reason: 'attribute innerhtml' },
    { name: 'DOM props innerHTML', jsx: '<span domPropsInnerHTML={html} />', reason: 'attribute dompropsinnerhtml' },
    { name: 'island marker', jsx: '<span data-docs-island="search" />', reason: 'attribute data-docs-island' },
    { name: 'spread attributes', jsx: '<span {...props}>Text</span>', reason: 'explicit attribute names' },
    { name: 'member component', jsx: '<Components.Guide />', reason: 'explicit inline tag or imported typed component' },
  ])('rejects $name in article locale JSX', async ({ jsx, reason }) => {
    await expect(validate({
      filename: 'pages/test/messages/en.tsx',
      source: `export const messages = { body: () => <>Before ${jsx} after</> };`,
    })).rejects.toThrow(reason);
  });

  it('checks component imports by resolved target and rejects local shadowing', async () => {
    await expect(validate({
      filename: 'pages/test/messages/en.tsx',
      source: `\
import DocsLink from '../../../components/Other.vue';
export const messages = { body: () => <DocsLink href="/docs/">Wrong target</DocsLink> };`,
    })).rejects.toThrow('Unsupported static Docs rich JSX element');
    await expect(validate({
      filename: 'pages/test/messages/en.tsx',
      source: `\
import DocsLink from '../../../components/DocsLink.vue';
export const messages = { body: () => { const DocsLink = 'a'; return <DocsLink href="/docs/">Wrong binding</DocsLink>; } };`,
    })).rejects.toThrow('cannot be shadowed');
    await expect(validate({
      filename: 'pages/test/messages/en.tsx',
      source: `\
import docsLink from '../../../components/DocsLink.vue';
export const messages = { body: () => <docsLink locale="en" page="index">Wrong JSX tag</docsLink> };`,
    })).rejects.toThrow('Unsupported static Docs rich JSX element');
  });

  it('keeps article messages flat and creates JSX inside a message function', async () => {
    for (const value of ['["one", "two"]', '{ nested: "text" }', '<strong>Text</strong>', '(<><strong>Text</strong></>)']) {
      await expect(validate({
        filename: 'pages/test/messages/en.tsx',
        source: `export const messages = { body: ${value} };`,
      })).rejects.toThrow('literal text or inline functions that create fresh rich content');
    }
    await expect(validate({
      filename: 'pages/test/messages/en.tsx',
      source: 'const shared = <strong>Text</strong>; export const messages = { body: () => shared };',
    })).rejects.toThrow('cannot be initialized at module scope');
    await expect(validate({
      filename: 'pages/test/messages/en.tsx',
      source: 'export const messages = { items: () => ["one", "two"], body: () => <strong>Text</strong> };',
    })).resolves.toBeUndefined();
  });

  it('requires snake_case article message keys in both locales', async () => {
    for (const locale of ['en', 'ja']) {
      const canonical = locale === 'ja' ? " satisfies typeof import('./en').messages" : '';
      await expect(validate({
        filename: `pages/test/messages/${locale}.tsx`,
        source: `export const messages = { title: "Title", "step_body": () => <strong>Step</strong> }${canonical};`,
      })).resolves.toBeUndefined();
      for (const key of ['stepBody', 'Step_body', 'step__body', 'step_body_', '"step body"']) {
        await expect(validate({
          filename: `pages/test/messages/${locale}.tsx`,
          source: `export const messages = { ${key}: "Text" }${canonical};`,
        })).rejects.toThrow('message keys must use snake_case');
      }
      await expect(validate({
        filename: `pages/test/messages/${locale}.tsx`,
        source: `export const messages = { ["step_body"]: "Text" }${canonical};`,
      })).rejects.toThrow('message keys must use snake_case');
      await expect(validate({
        filename: `pages/test/messages/${locale}.tsx`,
        source: `export const messages = { ...other }${canonical};`,
      })).rejects.toThrow('explicit flat message keys');
    }
  });

  it('checks plain locale message keys without treating domain records as message keys', async () => {
    await expect(validate({
      filename: 'messages/common/en.ts',
      source: `\
import { messages as chrome } from '../replica-chrome/en';
import { messages as searchUi } from '../search-ui/en';
export const messages = {
  ...chrome,
  ...searchUi,
  search_purpose_descriptions: { 'chat-branching': 'Branch conversations' },
  navigation: { groups: { start: 'Start here' }, pages: { 'chat-branching': 'Branch and edit' } },
};`,
    })).resolves.toBeUndefined();
    for (const { filename, source } of [
      { filename: 'messages/common/en.ts', source: "export const messages = { newChat: 'New Chat' };" },
      { filename: 'messages/common/ja.ts', source: "export const messages = { closeSearch: '閉じる' } satisfies typeof import('./en').messages;" },
      { filename: 'messages/common/en.ts', source: "export const messages = { skipToContent: 'Skip' };" },
      { filename: 'messages/entry/en.ts', source: "export const messages = { missingTitle: 'Missing' };" },
      { filename: 'islands/browser-ai-availability/messages/ja.ts', source: "export const messages = { apiAbsent: '利用不可' } satisfies typeof import('./en').messages;" },
    ]) {
      await expect(validate({ filename, source })).rejects.toThrow('message keys must use snake_case');
    }
    await expect(validate({
      filename: 'messages/common/en.ts',
      source: "export const messages = { ...other, guide_home: 'Guides' };",
    })).rejects.toThrow('explicit flat message keys');
  });

  it('requires a direct plain messages object and the English canonical check in Japanese', async () => {
    for (const filename of ['messages/common/ja.ts', 'messages/entry/ja.ts', 'messages/replica-chrome/ja.ts', 'messages/search-ui/ja.ts', 'islands/browser-ai-availability/messages/ja.ts']) {
      for (const suffix of [
        '', " satisfies typeof import('./ja').messages", " satisfies typeof import('./other').messages",
        " satisfies typeof import('./en').strings", ' satisfies Record<string, string>',
      ]) {
        await expect(validate({ filename, source: `export const messages = { heading: '案内' }${suffix};` }))
          .rejects.toThrow("require satisfies typeof import('./en').messages");
      }
      await expect(validate({ filename, source: "export const messages = { heading: '案内' } satisfies typeof import('./en').messages;" }))
        .resolves.toBeUndefined();
      await expect(validate({ filename, source: "const messages = { heading: '案内' } satisfies typeof import('./en').messages; export { messages };" }))
        .rejects.toThrow('directly export const messages');
    }
    await expect(validate({ filename: 'messages/entry/en.ts', source: "export let messages = { heading: 'Title' };" }))
      .rejects.toThrow('exported as a const object');
    await expect(validate({ filename: 'messages/entry/en.ts', source: "const messages = { heading: 'Title' }; export { messages };" }))
      .rejects.toThrow('directly export const messages');
  });

  it('keeps plain message values literal while preserving common domain metadata', async () => {
    for (const filename of ['messages/entry/en.ts', 'messages/replica-chrome/en.ts', 'messages/search-ui/en.ts', 'islands/browser-ai-availability/messages/en.ts']) {
      await expect(validate({ filename, source: "export const messages = { heading: `Title` };" })).resolves.toBeUndefined();
      await expect(validate({ filename, source: "export const messages = { count: ({ count }: { count: number }): string => `${count} results` };" }))
        .resolves.toBeUndefined();
      await expect(validate({ filename, source: "export const messages = { heading: function (): string { return 'Title'; } };" }))
        .resolves.toBeUndefined();
      for (const value of ["{ text: 'Title' }", 'makeTitle()', 'title', '() => "Title"', '(): number => 1', 'function (): object { return {}; }', '`Title ${locale}`']) {
        await expect(validate({ filename, source: `export const messages = { heading: ${value} };` }))
          .rejects.toThrow('require literal text values');
      }
    }
    await expect(validate({
      filename: 'messages/search-ui/ja.ts',
      source: "export const messages = { count: ({ count }: { count: number }): string => `${count} 件` } satisfies typeof import('./en').messages;",
    })).resolves.toBeUndefined();
    await expect(validate({
      filename: 'messages/common/en.ts',
      source: `import { messages as chrome } from '../replica-chrome/en'; import { messages as searchUi } from '../search-ui/en';
export const messages = { ...chrome, ...searchUi, navigation: { groups: { start: 'Start' } }, search_purpose_descriptions: { 'chat-branching': 'Branch' }, heading: 'Title' };`,
    })).resolves.toBeUndefined();
    await expect(validate({ filename: 'messages/common/en.ts', source: "export const messages = { navigation: { bogus: true }, heading: { text: 'Title' } };" }))
      .rejects.toThrow('require literal text values');
    await expect(validate({ filename: 'messages/common/en.ts', source: "const chrome = { heading: { text: 'Title' } }; export const messages = { ...chrome };" }))
      .rejects.toThrow('matching locale messages');
    await expect(validate({
      filename: 'messages/common/ja.ts',
      source: `import { messages as chrome } from '../replica-chrome/en';
export const messages = { ...chrome } satisfies typeof import('./en').messages;`,
    })).rejects.toThrow('matching locale messages');
  });

  it('allows only literal text or inline functions as article message values', async () => {
    await expect(validate({
      filename: 'pages/test/messages/en.tsx',
      source: "export const messages = { title: 'Title', subtitle: `Subtitle`, body: () => <strong>Text</strong>, detail: function () { return <em>More</em>; } };",
    })).resolves.toBeUndefined();
    for (const value of ['makeBody()', 'body', '{ text: "Text" }', '["Text"]', '`Text ${name}`', '<strong>Text</strong>']) {
      await expect(validate({ filename: 'pages/test/messages/en.tsx', source: `export const messages = { body: ${value} };` }))
        .rejects.toThrow('literal text or inline functions');
    }
    for (const member of ['body', 'body() { return <strong>Text</strong>; }']) {
      await expect(validate({ filename: 'pages/test/messages/en.tsx', source: `const body = () => <strong>Text</strong>; export const messages = { ${member} };` }))
        .rejects.toThrow('explicit scalar values or functions');
    }
  });

  it('rejects static value imports of application runtime while allowing types, assets, and packages', async () => {
    const repoRoot = '/repo';
    const sourceRoot = `${repoRoot}/docs`;
    const resolvedFiles = new Map([
      ['@app/client', `${repoRoot}/src/client.ts`],
      ['@app/component', `${repoRoot}/src/Component.vue?raw`],
      ['@app/logo', `${repoRoot}/src/assets/logo.svg?raw`],
      ['@app/style', `${repoRoot}/src/styles/site.css`],
      ['@docs/style', `${sourceRoot}/styles/site.css`],
      ['@pkg/inside', `${repoRoot}/node_modules/pkg/index.js`],
      ['@pkg/outside', '/external/pnpm/store/pkg/index.mjs'],
      ['vue', `${repoRoot}/node_modules/vue/dist/vue.runtime.esm-bundler.js`],
      ['lucide-vue-next', `${repoRoot}/node_modules/lucide-vue-next/dist/index.js`],
    ]);
    const check = async (source: string): Promise<void> => validateDocsAuthoringSource({
      source,
      filename: 'pages/test/index.vue',
      root: sourceRoot,
      resolve: async ({ specifier }) => resolvedFiles.get(specifier),
    });
    for (const script of [
      "import { client } from '@app/client';",
      "export { client } from '@app/client';",
      "const client = import('@app/client');",
      "const client = require('@app/client');",
      "import Component from '@app/component';",
    ]) {
      await expect(check(`<script setup lang="ts">${script}</script>`)).rejects.toThrow('repository runtime code outside Docs');
    }
    for (const script of [
      "import type { Client } from '@app/client';",
      "export type { Client } from '@app/client';",
      "import logo from '@app/logo';",
      "import '@app/style';",
      "import '@docs/style';",
      "import { thing } from '@pkg/inside';",
      "import { thing } from '@pkg/outside';",
      "import { ref } from 'vue';",
      "import { Menu } from 'lucide-vue-next';",
    ]) {
      await expect(check(`<script setup lang="ts">${script}</script>`)).resolves.toBeUndefined();
    }
  });

  it('requires Japanese article and branching messages to check the English canonical object', async () => {
    for (const filename of ['pages/test/messages/ja.tsx', 'islands/branching/messages/ja.tsx']) {
      for (const suffix of [
        '',
        " satisfies typeof import('./ja').messages",
        " satisfies typeof import('./other').messages",
        " satisfies typeof import('./en').strings",
        ' satisfies Record<string, string>',
      ]) {
        await expect(validate({
          filename,
          source: `export const messages = { title: '案内' }${suffix};`,
        })).rejects.toThrow("require satisfies typeof import('./en').messages");
      }
      await expect(validate({
        filename,
        source: "export const messages = { title: '案内' } satisfies typeof import('./en').messages;",
      })).resolves.toBeUndefined();
    }
  });

  it('allows nested branching island messages while keeping their rich JSX inside the safe subset', async () => {
    await expect(validate({
      filename: 'islands/branching/messages/en.tsx',
      source: `\
import UiLabel from '../../../components/UiLabel.vue';
export const messages = {
  note: () => <>Choose <UiLabel text="Replay this method" />.</>,
  methods: { edit: { title: 'Edit', stages: [() => <span>First</span>, () => <strong>Second</strong>] } },
};`,
    })).resolves.toBeUndefined();
    await expect(validate({
      filename: 'islands/branching/messages/ja.tsx',
      source: "export const messages = { methods: { edit: { stages: [() => <span>最初</span>] } } } satisfies typeof import('./en').messages;",
    })).resolves.toBeUndefined();
    await expect(validate({
      filename: 'islands/branching/messages/en.tsx',
      source: "import { onMounted } from 'vue'; export const messages = { note: () => <span>Note</span> };",
    })).rejects.toThrow('Vue onMounted is not called');
    await expect(validate({
      filename: 'islands/branching/messages/en.tsx',
      source: 'export const messages = { note: () => <span onClick={run}>Bad</span> };',
    })).rejects.toThrow('attribute onclick');
    await expect(validate({
      filename: 'islands/search/messages/en.tsx',
      source: 'export const messages = { note: () => <span>Unsupported island</span> };',
    })).rejects.toThrow('supported only in article and branching island locale messages');
  });

  it('limits JSX to article locale modules and keeps it out of static SFC setup', async () => {
    await expect(validate({ filename: 'components/unsafe.tsx', source: 'export const node = <a href="/">Raw</a>;' }))
      .rejects.toThrow('supported only in article and branching island locale messages');
    await expect(validate({ filename: 'components/unsafe.jsx', source: 'export const node = <a href="/">Raw</a>;' }))
      .rejects.toThrow('supported only in article and branching island locale messages');
    await expect(validate({
      filename: 'pages/test/index.vue',
      source: '<script setup lang="tsx">const node = <a href="/">Raw</a>;</script><template><p>Page</p></template>',
    })).rejects.toThrow('Static Docs JSX is supported only in locale message modules');
  });

  it('keeps article locale JSX value imports behind the server registry', async () => {
    await expect(validate({
      filename: 'pages/test/index.vue',
      source: '<script setup lang="ts">import { messages } from "./messages/en.tsx";</script><template><p>{{ messages.title }}</p></template>',
    })).rejects.toThrow('server registry only');
    await expect(validate({
      filename: 'components/types.ts',
      source: "import type { messages } from '../pages/test/messages/en.tsx'; export type PageCopy = typeof messages;",
    })).resolves.toBeUndefined();
  });
});
