<script setup lang="ts">
import RenderText from '../../components/RenderText';
import OpenAiCompatibleSettingsStep from '../../components/demos/OpenAiCompatibleSettingsStep.vue';
import RelatedGuide from '../../components/RelatedGuide.vue';
import type { DocsLocale } from '../../navigation/routes';
import type { CommonMessages, OpenAiCompatibleGuideMessages } from '../../messages/types';

defineProps<{ s: OpenAiCompatibleGuideMessages; locale: DocsLocale; common: CommonMessages }>();

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <article class="prose" data-testid="docs-models-openai-compatible">
    <h1>{{ s.title }}</h1>
    <p class="lead">{{ s.intro }}</p>
    <p class="app-entry-intro"><RenderText :node="s.open_app({ locale, destination: { kind: 'screen', screen: 'home' } })" /></p>
    <p class="before-step">{{ s.server_prerequisite }}</p>

    <section class="walkthrough-step" aria-labelledby="openai-open">
      <h2 id="openai-open">{{ s.open_connection_settings_heading }}</h2>
      <p><RenderText :node="s.open_connection_settings_instructions()" /></p>
      <figure class="guide-figure"><OpenAiCompatibleSettingsStep stage="open" :messages="s" /><figcaption class="caption"><RenderText :node="s.open_connection_settings_figure_caption()" /></figcaption></figure>
    </section>

    <section class="walkthrough-step" aria-labelledby="openai-provider">
      <h2 id="openai-provider">{{ s.choose_compatible_provider_heading }}</h2>
      <p><RenderText :node="s.choose_compatible_provider_instructions()" /></p>
      <figure class="guide-figure"><OpenAiCompatibleSettingsStep stage="provider" :messages="s" /><figcaption class="caption">{{ s.choose_compatible_provider_figure_caption }}</figcaption></figure>
    </section>

    <section class="walkthrough-step" aria-labelledby="openai-headers">
      <h2 id="openai-headers">{{ s.configure_http_headers_heading }}</h2>
      <p><RenderText :node="s.configure_http_headers_instructions()" /></p>
      <figure class="guide-figure"><OpenAiCompatibleSettingsStep stage="headers" :messages="s" /><figcaption class="caption"><RenderText :node="s.configure_http_headers_figure_caption()" /></figcaption></figure>
    </section>

    <section class="walkthrough-step" aria-labelledby="openai-check">
      <h2 id="openai-check">{{ s.check_server_connection_heading }}</h2>
      <p><RenderText :node="s.check_server_connection_instructions()" /></p>
      <figure class="guide-figure"><OpenAiCompatibleSettingsStep stage="check" :messages="s" /><figcaption class="caption"><RenderText :node="s.check_server_connection_figure_caption()" /></figcaption></figure>
    </section>

    <section class="walkthrough-step" aria-labelledby="openai-model">
      <h2 id="openai-model">{{ s.choose_server_model_heading }}</h2>
      <p><RenderText :node="s.choose_server_model_instructions()" /></p>
      <figure class="guide-figure"><OpenAiCompatibleSettingsStep stage="model" :messages="s" /><figcaption class="caption"><RenderText :node="s.choose_server_model_figure_caption()" /></figcaption></figure>
    </section>

    <h2>{{ s.server_troubleshooting_heading }}</h2>
    <p>{{ s.server_troubleshooting }}</p>
    <RelatedGuide :locale="locale" :eyebrow="common.related_guides" :guides="[{ page: 'local-ai-servers', title: s.local_server_guide_title, description: s.local_server_guide_description }]" />
  </article>
</template>

<style scoped>
.before-step {
  padding: 17px 20px;
  border-left: 3px solid var(--blue);
  background: var(--surface);
  border-radius: 0 10px 10px 0;
}
.walkthrough-step {
  border-top: 1px solid var(--line);
  margin-top: 38px;
  padding-top: 22px;
}
.walkthrough-step h2 {
  margin-top: 0;
}
.walkthrough-step>p {
  margin-bottom: 0;
}
.walkthrough-step .guide-figure {
  margin: 18px 0 0;
}
.walkthrough-step figcaption {
  margin-inline: auto;
  max-width: 660px;
}
</style>
