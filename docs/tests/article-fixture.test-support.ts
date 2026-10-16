import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DOCS_LOCALES, DOCS_PAGES } from '../navigation/routes';
import type { DocsLocale } from '../navigation/routes';

const localeTypeChecks = { en: '', ja: " satisfies typeof import('./en').messages" } satisfies Record<DocsLocale, string>;

// Build lifecycle checks need every registered route, without compiling the
// demonstration catalog whose content has separate production coverage.
export async function writeMinimalArticleFixtures({ root }: { root: string }) {
  for (const page of DOCS_PAGES) {
    await writeFile(path.join(root, page.source), `\
<script setup lang="ts">
import type { CommonMessages } from '../../messages/types';
import type { DocsLocale } from '../../navigation/routes';
import type { messages } from './messages/en';
defineProps<{ s: typeof messages; locale: DocsLocale; common: CommonMessages }>();
</script>
<template>
  <article class="prose">
    <h1>{{ s.title }}</h1>
    <p>{{ s.description }}</p>
    <h2>{{ s.heading }}</h2>
    <p>{{ s.paragraph }}</p>
  </article>
</template>`);
    for (const locale of DOCS_LOCALES) {
      await writeFile(path.join(root, 'pages', page.id, 'messages', `${locale}.tsx`), `\
export const messages = {
  title: 'Fixture ${page.id} in ${locale}',
  description: 'Fixture article description in ${locale}.',
  heading: 'Server-only article heading in ${locale}.',
  paragraph: 'Fixture article paragraph in ${locale}.',
}${localeTypeChecks[locale]};`);
    }
  }
}
