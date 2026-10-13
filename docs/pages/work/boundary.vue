<script setup lang="ts">
import BoundaryDiagram from '../../site/demos/BoundaryDiagram.vue';
import { docsHref } from '../../site/routes';
import type { DocsLocale } from '../../site/routes';
import type { BoundaryMessages } from '../../site/messages';

defineProps<{ s: BoundaryMessages; locale: DocsLocale }>();


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
    data-testid="docs-boundary"
  >
    <h1>{{ s.title }}</h1>
    <p
      v-for="paragraph in s.intro"
      :key="paragraph"
      class="lead"
    >{{ paragraph }}</p>
    <h2>{{ s.diagramTitle }}</h2>
    <figure class="guide-figure"><BoundaryDiagram /><figcaption class="caption">{{ s.motionNote }}</figcaption></figure>
    <section
      v-for="section in s.sections"
      :key="section.title"
    >
      <h2>{{ section.title }}</h2>
      <p>{{ section.body }}</p>
    </section>
    <a
      class="next-link"
      :href="docsHref({ locale, page: 'files/privacy' })"
    >{{ s.next }} <span aria-hidden="true">→</span></a>
  </article>
</template>
