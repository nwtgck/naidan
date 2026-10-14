<script setup lang="ts">
import DocsLink from '../../site/DocsLink.vue';
import BoundaryDiagram from '../../site/demos/BoundaryDiagram.vue';
import RelatedGuide from '../../site/RelatedGuide.vue';
import type { DocsLocale } from '../../site/routes';
import type { BoundaryMessages, CommonMessages } from '../../site/messages';

defineProps<{ s: BoundaryMessages; locale: DocsLocale; common: CommonMessages }>();


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
    <figure class="guide-figure"><BoundaryDiagram :copy="s.demo" /><figcaption class="caption">{{ s.motionNote }}</figcaption></figure>
    <section
      v-for="section in s.sections"
      :key="section.title"
    >
      <h2>{{ section.title }}</h2>
      <p>{{ section.body }}</p>
    </section>
    <p class="network-guide"><DocsLink :locale="locale" page="csp-editions">{{ s.localOnlyGuide }} <span aria-hidden="true">→</span></DocsLink></p>
    <RelatedGuide :locale="locale" :eyebrow="common.relatedGuides" :guides="[{ page: 'file-access', title: s.next, description: s.nextDescription }, { page: 'web-and-native-app-permissions', title: s.appPermissionsTitle, description: s.appPermissionsDescription }]" />
  </article>
</template>

<style scoped>
.network-guide { margin-top: 12px; font-size: 13px; }
</style>
