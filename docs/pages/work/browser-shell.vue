<script setup lang="ts">
import { docsHref } from '../../site/routes';
import type { DocsLocale } from '../../site/routes';
import type { ShellMessages } from '../../site/messages';

defineProps<{ s: ShellMessages; locale: DocsLocale }>();
const example = `\
ls /sys/fs/naidan/current-chat
cat /sys/fs/naidan/current-chat/metadata.md`;


defineExpose({
  ...((__BUILD_MODE_IS_TEST__ && {
    TEST_ONLY: {
      // Export internal state and logic used only for testing here. Do not reference these in production logic.
      // ESLint-required for defineExpose.
    },
  }) || {}),
});
</script>

<template>
  <article
    class="prose"
    data-testid="docs-shell"
  >
    <h1>{{ s.title }}</h1>
    <p
      v-for="paragraph in s.intro"
      :key="paragraph"
      class="lead"
    >{{ paragraph }}</p>
    <section
      v-for="section in s.sections"
      :key="section.title"
    >
      <h2>{{ section.title }}</h2>
      <p>{{ section.body }}</p>
    </section>
    <h2>{{ s.exampleTitle }}</h2><pre lang="en"><code>{{ example }}</code></pre>
    <p class="caption">{{ s.exampleNote }}</p>
    <a
      class="next-link"
      :href="docsHref({ locale, page: 'files/privacy' })"
    >{{ s.next }} <span aria-hidden="true">→</span></a>
  </article>
</template>
