<script setup lang="ts">
import DocsLink from '../../components/DocsLink.vue';
import BrowserBoundaryDiagram from '../../components/demos/BrowserBoundaryDiagram.vue';
import RelatedGuide from '../../components/RelatedGuide.vue';
import type { DocsLocale } from '../../navigation/routes';
import type { BoundaryMessages, CommonMessages } from '../../messages/types';

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
      v-for="paragraph in s.intro_paragraphs()"
      :key="paragraph"
      class="lead"
    >{{ paragraph }}</p>
    <h2>{{ s.os_and_browser_boundaries_heading }}</h2>
    <figure class="guide-figure"><BrowserBoundaryDiagram :messages="s" /><figcaption class="caption">{{ s.os_and_browser_boundaries_caption }}</figcaption></figure>
    <section><h2>{{ s.choose_the_input_heading }}</h2><p>{{ s.choose_the_input_description }}</p></section>
    <section><h2>{{ s.browser_runs_the_model_heading }}</h2><p>{{ s.browser_runs_the_model_description }}</p></section>
    <section><h2>{{ s.connections_have_a_purpose_heading }}</h2><p>{{ s.connections_have_a_purpose_description }}</p></section>
    <p class="network-guide"><DocsLink :locale="locale" page="csp-editions">{{ s.local_only_guide_link }} <span aria-hidden="true">→</span></DocsLink></p>
    <RelatedGuide :locale="locale" :eyebrow="common.related_guides" :guides="[{ page: 'file-access', title: s.file_access_guide_title, description: s.file_access_guide_description }, { page: 'web-and-native-app-permissions', title: s.app_permissions_guide_title, description: s.app_permissions_guide_description }]" />
  </article>
</template>

<style scoped>
.network-guide {
  margin-top: 12px;
  font-size: 13px;
}
</style>
