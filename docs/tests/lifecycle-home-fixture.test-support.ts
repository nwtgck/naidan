import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DOCS_LOCALES } from '../navigation/routes';
import type { DocsLocale } from '../navigation/routes';

const localeTypeChecks = { en: '', ja: " satisfies typeof import('./en').messages" } satisfies Record<DocsLocale, string>;

// Keep the real layout and locale loading while excluding unrelated home demos.
export async function writeLifecycleHomeFixture({ root }: { root: string }): Promise<void> {
  await writeFile(path.join(root, 'pages/index/index.vue'), `\
<script setup lang="ts">
import RenderText from '../../components/RenderText';
import type { CommonMessages } from '../../messages/types';
import type { DocsLocale } from '../../navigation/routes';
import type { messages } from './messages/en';
const props = defineProps<{ s: typeof messages; locale: DocsLocale; common: CommonMessages }>();
const discardedRich = props.s.rich_content();
discardedRich.pop();
const discardedList = props.s.list_content();
discardedList[0] += ' A stale list leaked.';
</script>
<template>
  <article>
    <h1>{{ s.title }}</h1>
    <p>{{ s.description }}</p>
    <h2>{{ s.heading }}</h2>
    <p data-testid="lifecycle-rich"><RenderText v-for="(node, index) in s.rich_content()" :key="index" :node="node" /></p>
    <ul data-testid="lifecycle-list"><li v-for="text in s.list_content()" :key="text">{{ text }}</li></ul>
  </article>
</template>`);
  for (const locale of DOCS_LOCALES) {
    await writeFile(path.join(root, 'pages/index/messages', `${locale}.tsx`), `\
export const messages = {
  title: 'Lifecycle home in ${locale}',
  description: 'Lifecycle article in ${locale}.',
  heading: 'Live heading in ${locale}.',
  rich_content: () => [<>Rich content in <strong>${locale}</strong>.</>],
  list_content: () => ['Fresh list in ${locale}.'],
}${localeTypeChecks[locale]};`);
  }
}
