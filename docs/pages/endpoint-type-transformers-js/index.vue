<script setup lang="ts">
import RenderText from '../../components/RenderText';
import BrowserModelSettingsStep from '../../components/demos/BrowserModelSettingsStep.vue';
import RelatedGuide from '../../components/RelatedGuide.vue';
import type { DocsLocale } from '../../navigation/routes';
import type { CommonMessages } from '../../messages/types';
import type { messages as english } from '../../pages/endpoint-type-transformers-js/messages/en';

defineProps<{ s: typeof english; locale: DocsLocale; common: CommonMessages }>();

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <article class="prose" data-testid="docs-models-transformers-js">
    <h1>{{ s.title }}</h1>
    <p class="lead">{{ s.intro }}</p>
    <p class="app-entry-intro"><RenderText :node="s.open_model_manager({ locale, destination: { kind: 'screen', screen: 'transformers-js-manager' } })" /></p>
    <p class="app-entry-onboarding"><RenderText :node="s.model_manager_first_run_note()" /></p>
    <p class="guide-context">{{ s.availability }}</p>

    <section class="walkthrough-step" aria-labelledby="transformers-guide-open">
      <h2 id="transformers-guide-open">{{ s.open_model_manager_heading }}</h2>
      <p><RenderText :node="s.open_model_manager_instructions()" /></p>
      <figure class="guide-figure">
        <BrowserModelSettingsStep mode="transformers" stage="open" :messages="s" />
        <figcaption class="caption">{{ s.open_model_manager_figure_caption }}</figcaption>
      </figure>
    </section>

    <section class="walkthrough-step" aria-labelledby="transformers-guide-download">
      <h2 id="transformers-guide-download">{{ s.download_onnx_model_heading }}</h2>
      <p><RenderText :node="s.download_onnx_model_instructions()" /></p>
      <figure class="guide-figure">
        <BrowserModelSettingsStep mode="transformers" stage="download" :messages="s" />
        <figcaption class="caption"><RenderText :node="s.download_onnx_model_figure_caption()" /></figcaption>
      </figure>
    </section>

    <section class="walkthrough-step" aria-labelledby="transformers-guide-resume">
      <h2 id="transformers-guide-resume">{{ s.load_or_resume_model_heading }}</h2>
      <p><RenderText :node="s.load_or_resume_model_instructions()" /></p>
      <figure class="guide-figure">
        <BrowserModelSettingsStep mode="transformers" stage="resume" :messages="s" />
        <figcaption class="caption"><RenderText :node="s.load_or_resume_model_figure_caption()" /></figcaption>
      </figure>
    </section>

    <section class="walkthrough-step" aria-labelledby="transformers-guide-save">
      <h2 id="transformers-guide-save">{{ s.save_default_model_heading }}</h2>
      <p><RenderText :node="s.save_default_model_instructions()" /></p>
      <figure class="guide-figure">
        <BrowserModelSettingsStep mode="transformers" stage="save" :messages="s" />
        <figcaption class="caption"><RenderText :node="s.save_default_model_figure_caption()" /></figcaption>
      </figure>
    </section>

    <h2>{{ s.model_troubleshooting_heading }}</h2>
    <p><RenderText :node="s.model_troubleshooting()" /></p>
    <RelatedGuide :locale="locale" :eyebrow="common.related_guides" :guides="[{ page: 'in-browser-models', title: s.browser_model_guide_title, description: s.browser_model_guide_description }]" />
  </article>
</template>

<style scoped>
.guide-context { padding:17px 20px;border-left:3px solid var(--blue);background:var(--surface);border-radius:0 10px 10px 0; }
.walkthrough-step { border-top:1px solid var(--line);margin-top:38px;padding-top:22px; }
.walkthrough-step h2 { margin-top:0; }
.walkthrough-step > p { margin-bottom:0; }
.walkthrough-step .guide-figure { margin:18px 0 0; }
.walkthrough-step figcaption { margin-inline:auto;max-width:660px; }
</style>
