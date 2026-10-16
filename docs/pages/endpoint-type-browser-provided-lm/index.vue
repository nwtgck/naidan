<script setup lang="ts">
import RenderText from '../../components/RenderText';
import ChromeModelFlow from '../../components/demos/ChromeModelFlow.vue';
import BrowserProvidedModelSettingsStep from '../../components/demos/BrowserProvidedModelSettingsStep.vue';
import RelatedGuide from '../../components/RelatedGuide.vue';
import DocsIsland from '../../components/DocsIsland.vue';
import { browserAiAvailabilityIsland } from '../../islands/browser-ai-availability/definition';
import type { DocsLocale } from '../../navigation/routes';
import type { BrowserProvidedGuideMessages, CommonMessages } from '../../messages/types';

defineProps<{ s: BrowserProvidedGuideMessages; locale: DocsLocale; common: CommonMessages }>();

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <article class="prose" data-testid="docs-models-browser-provided">
    <h1>{{ s.title }}</h1>
    <p class="lead">{{ s.intro }}</p>
    <section class="concept-section" aria-labelledby="browser-model-flow">
      <h2 id="browser-model-flow">{{ s.chrome_model_flow_heading }}</h2>
      <figure class="guide-figure"><ChromeModelFlow :messages="s" /><figcaption class="caption">{{ s.chrome_model_flow_caption }}</figcaption></figure>
    </section>

    <DocsIsland :entry="browserAiAvailabilityIsland({ locale })" />

    <details class="requirements-details">
      <summary>{{ s.chrome_requirements_heading }}</summary>
      <p>{{ s.chrome_device_requirements }}</p>
      <p>{{ s.japanese_language_support }}</p>
      <p class="requirements-source"><RenderText :node="s.chrome_requirements_sources({ locale, requirementsHref: 'https://developer.chrome.com/docs/ai/prompt-api', languageHref: 'https://developer.chrome.com/docs/ai/get-started' })" /></p>
    </details>

    <p class="app-entry-intro"><RenderText :node="s.open_connection_settings({ locale, destination: { kind: 'screen', screen: 'connection' } })" /></p>
    <p class="app-entry-onboarding"><RenderText :node="s.connection_first_run_note()" /></p>

    <section class="walkthrough-step" aria-labelledby="browser-open">
      <h2 id="browser-open">{{ s.open_connection_settings_heading }}</h2>
      <p><RenderText :node="s.open_connection_settings_instructions()" /></p>
      <figure class="guide-figure"><BrowserProvidedModelSettingsStep stage="open" :messages="s" /><figcaption class="caption"><RenderText :node="s.open_connection_settings_figure_caption()" /></figcaption></figure>
    </section>

    <section class="walkthrough-step" aria-labelledby="browser-select">
      <h2 id="browser-select">{{ s.select_chrome_model_heading }}</h2>
      <p><RenderText :node="s.select_chrome_model_instructions()" /></p>
      <figure class="guide-figure"><BrowserProvidedModelSettingsStep stage="select" :messages="s" /><figcaption class="caption"><RenderText :node="s.select_chrome_model_figure_caption()" /></figcaption></figure>
    </section>

    <section class="walkthrough-step" aria-labelledby="browser-prepare">
      <h2 id="browser-prepare">{{ s.prepare_chrome_model_heading }}</h2>
      <p><RenderText :node="s.prepare_chrome_model_instructions()" /></p>
      <figure class="guide-figure"><BrowserProvidedModelSettingsStep stage="prepare" :messages="s" /><figcaption class="caption">{{ s.prepare_chrome_model_figure_caption }}</figcaption></figure>
    </section>

    <section class="walkthrough-step" aria-labelledby="browser-save">
      <h2 id="browser-save">{{ s.save_connection_heading }}</h2>
      <p><RenderText :node="s.save_connection_instructions()" /></p>
      <figure class="guide-figure"><BrowserProvidedModelSettingsStep stage="save" :messages="s" /><figcaption class="caption">{{ s.save_connection_figure_caption }}</figcaption></figure>
    </section>

    <p><RenderText :node="s.start_chat_with_chrome_model()" /></p>

    <h2>{{ s.chrome_model_unavailable_heading }}</h2>
    <p>{{ s.chrome_model_unavailable_help }}</p>
    <RelatedGuide :locale="locale" :eyebrow="common.related_guides" :guides="[{ page: 'in-browser-models', title: s.browser_model_guide_title, description: s.browser_model_guide_description }]" />
  </article>
</template>

<style scoped>
.concept-section h2{margin-bottom:0}
.concept-section .guide-figure{margin:18px 0 28px}
.concept-section figcaption{margin-inline:auto;max-width:660px}
.requirements-details{margin:30px 0 28px;padding:0 20px;border:1px solid var(--line-strong);border-radius:12px;background:var(--surface)}
.requirements-details summary{padding:17px 0;color:var(--text);font-weight:750;cursor:pointer}
.requirements-details summary:focus-visible{outline:2px solid var(--blue);outline-offset:3px}
.requirements-details[open] summary{border-bottom:1px solid var(--line)}
.requirements-details p{margin:16px 0 0}
.requirements-details .requirements-source{margin:10px 0 17px;font-size:.9em}
.walkthrough-step{border-top:1px solid var(--line);margin-top:38px;padding-top:22px}
.walkthrough-step h2{margin-top:0}
.walkthrough-step>p{margin-bottom:0}
.walkthrough-step .guide-figure{margin:18px 0 0}
.walkthrough-step figcaption{margin-inline:auto;max-width:660px}
</style>
