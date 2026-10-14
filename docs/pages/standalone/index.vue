<script setup lang="ts">
import ExternalLink from '../../components/ExternalLink.vue';
import StandaloneDemo from '../../components/demos/StandaloneDemo.vue';
import RelatedGuide from '../../components/RelatedGuide.vue';
import RenderText from '../../components/RenderText';
import type { DocsLocale } from '../../navigation/routes';
import type { StandaloneMessages, CommonMessages } from '../../messages/types';
defineProps<{ s: StandaloneMessages; locale: DocsLocale; common: CommonMessages }>();


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
  <article class="prose" data-testid="docs-standalone">
    <h1>{{ s.title }}</h1>
    <p v-for="paragraph in s.intro_paragraphs()" :key="paragraph" class="lead">{{ paragraph }}</p>
    <figure class="guide-figure"><StandaloneDemo :messages="s" /><figcaption class="caption">{{ s.standalone_diagram_caption }}</figcaption></figure>
    <ExternalLink class="download-link" href="https://naidan.pages.dev/naidan-standalone.zip" :locale="locale">{{ s.download_standalone_zip }}</ExternalLink>
    <h2>{{ s.downloaded_folder_heading }}</h2>
    <ol class="guide-steps"><li><h3>{{ s.download_and_extract_heading }}</h3><p>{{ s.download_and_extract_description }}</p></li><li><h3>{{ s.open_index_html_heading }}</h3><p>{{ s.open_index_html_description }}</p></li><li><h3>{{ s.choose_model_or_engine_heading }}</h3><p>{{ s.choose_model_or_engine_description }}</p><p><RenderText :node="s.model_guides_after_opening({ locale, browserPage: 'in-browser-models', enginePage: 'local-ai-servers' })" /></p></li></ol>
    <h2>{{ s.no_server_meaning_heading }}</h2>
    <div class="pair-grid"><section class="panel"><h3>{{ s.no_app_server_heading }}</h3><p>{{ s.no_app_server_description }}</p></section><section class="panel"><h3>{{ s.inference_engine_choice_heading }}</h3><p>{{ s.inference_engine_choice_description }}</p></section></div>
    <section><h2>{{ s.browser_capabilities_heading }}</h2><p>{{ s.browser_capabilities_description }}</p></section>
    <section><h2>{{ s.retain_conversations_heading }}</h2><p><RenderText :node="s.retain_conversations_description()" /></p></section>
    <section><h2>{{ s.back_up_before_changes_heading }}</h2><p>{{ s.back_up_before_changes_description }}</p></section>
    <RelatedGuide :locale="locale" :eyebrow="common.related_guides" :guides="[
      { page: 'pwa', title: s.offline_pwa_guide_title, description: s.offline_pwa_guide_description },
      { page: 'hosted', title: s.hosted_zip_guide_title, description: s.hosted_zip_guide_description },
      { page: 'web-and-native-app-permissions', title: s.app_permissions_guide_title, description: s.app_permissions_guide_description },
      { page: 'browser-boundaries', title: s.browser_boundaries_guide_title, description: s.browser_boundaries_guide_description },
    ]" />
  </article>
</template>
