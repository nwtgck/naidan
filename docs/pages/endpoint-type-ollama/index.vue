<script setup lang="ts">
import RenderText from '../../components/RenderText';
import OllamaConnectionSettingsStep from '../../components/demos/OllamaConnectionSettingsStep.vue';
import RelatedGuide from '../../components/RelatedGuide.vue';
import type { DocsLocale } from '../../navigation/routes';
import type { CommonMessages, OllamaGuideMessages } from '../../messages/types';

defineProps<{ s: OllamaGuideMessages; locale: DocsLocale; common: CommonMessages }>();

defineExpose({
  ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}),
});
</script>

<template>
  <article class="prose" data-testid="docs-models-ollama">
    <h1>{{ s.title }}</h1>
    <p class="lead">{{ s.intro }}</p>
    <p class="app-entry-intro"><RenderText :node="s.open_app({ locale, destination: { kind: 'screen', screen: 'home' } })" /></p>
    <p class="before-step">{{ s.ollama_model_prerequisite }}</p>

    <section class="walkthrough-step" aria-labelledby="ollama-open">
      <h2 id="ollama-open">{{ s.open_connection_settings_heading }}</h2>
      <p><RenderText :node="s.open_connection_settings_instructions()" /></p>
      <figure class="guide-figure">
        <OllamaConnectionSettingsStep stage="open" :messages="s" />
        <figcaption class="caption"><RenderText :node="s.open_connection_settings_figure_caption()" /></figcaption>
      </figure>
    </section>

    <section class="walkthrough-step" aria-labelledby="ollama-provider">
      <h2 id="ollama-provider">{{ s.choose_ollama_provider_heading }}</h2>
      <p><RenderText :node="s.choose_ollama_provider_instructions()" /></p>
      <figure class="guide-figure">
        <OllamaConnectionSettingsStep stage="provider" :messages="s" />
        <figcaption class="caption">{{ s.choose_ollama_provider_figure_caption }}</figcaption>
      </figure>
    </section>

    <section class="walkthrough-step" aria-labelledby="ollama-check">
      <h2 id="ollama-check">{{ s.check_ollama_connection_heading }}</h2>
      <p><RenderText :node="s.check_ollama_connection_instructions()" /></p>
      <figure class="guide-figure">
        <OllamaConnectionSettingsStep stage="check" :messages="s" />
        <figcaption class="caption"><RenderText :node="s.check_ollama_connection_figure_caption()" /></figcaption>
      </figure>
    </section>

    <section class="walkthrough-step" aria-labelledby="ollama-model">
      <h2 id="ollama-model">{{ s.choose_ollama_model_heading }}</h2>
      <p><RenderText :node="s.choose_ollama_model_instructions()" /></p>
      <figure class="guide-figure">
        <OllamaConnectionSettingsStep stage="model" :messages="s" />
        <figcaption class="caption">{{ s.choose_ollama_model_figure_caption }}</figcaption>
      </figure>
    </section>

    <h2>{{ s.ollama_troubleshooting_heading }}</h2>
    <p><RenderText :node="s.ollama_troubleshooting()" /></p>
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
.walkthrough-step > p {
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
