<script setup lang="ts">
import RenderText from '../../components/RenderText';
import AppEntryLink from '../../components/AppEntryLink.vue';
import InBrowserModelSettingsStep from '../../components/demos/InBrowserModelSettingsStep.vue';
import RelatedGuide from '../../components/RelatedGuide.vue';
import type { DocsLocale } from '../../navigation/routes';
import type { CommonMessages } from '../../messages/types';
import type { messages as english } from '../../pages/endpoint-type-llama-cpp-browser/messages/en';

defineProps<{ s: typeof english; locale: DocsLocale; common: CommonMessages }>();

// Keep this shortlist in README Text Generation order. These are model
// identifiers, while the surrounding instructions are localized page copy.
const quickModels = [
  { name: 'Gemma 4 E2B it', model: 'hf.co/google/gemma-4-E2B-it-qat-q4_0-gguf:Q4_0' },
  { name: 'Gemma 4 E4B it', model: 'hf.co/google/gemma-4-E4B-it-qat-q4_0-gguf:Q4_0' },
  { name: 'Gemma 4 26B-A4B it', model: 'hf.co/google/gemma-4-26B-A4B-it-qat-q4_0-gguf:Q4_0' },
  { name: 'gpt-oss-20b', model: 'hf.co/ggml-org/gpt-oss-20b-GGUF:MXFP4' },
  { name: 'Qwen3.5 9B', model: 'hf.co/lmstudio-community/Qwen3.5-9B-GGUF:Q4_K_M' },
  { name: 'Qwen3.6 35B-A3B', model: 'hf.co/ggml-org/Qwen3.6-35B-A3B-GGUF:Q4_K_M' },
  { name: 'Qwen3.8 27B', model: 'hf.co/ggml-org/Qwen3.8-27B-GGUF:Q4_K_M' },
  { name: 'LFM2.5 230M', model: 'hf.co/LiquidAI/LFM2.5-230M-GGUF:Q4_K_M' },
  { name: 'LFM2.5 2.6B', model: 'hf.co/LiquidAI/LFM2.5-2.6B-GGUF:Q4_K_M' },
  { name: 'Muse-Glimmer 30B', model: 'hf.co/meta-models/Muse-Glimmer-30B-GGUF:Q4_K_M' },
  { name: 'SmolLM2 135M Instruct', model: 'hf.co/lmstudio-community/SmolLM2-135M-Instruct-GGUF:Q4_K_M' },
] as const;

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <article class="prose" data-testid="docs-models-llama-cpp-browser">
    <h1>{{ s.title }}</h1>
    <p class="lead"><RenderText :node="s.intro()" /></p>
    <section class="quick-models" aria-labelledby="llama-guide-quick-models">
      <h2 id="llama-guide-quick-models">{{ s.suggested_models_heading }}</h2>
      <p><RenderText :node="s.suggested_models_instructions()" /></p>
      <ul class="quick-model-list">
        <li v-for="item in quickModels" :key="item.model">
          <AppEntryLink :destination="{ kind: 'model', model: item.model }" :locale="locale" display="label">{{ item.name }}</AppEntryLink>
        </li>
      </ul>
      <p><RenderText :node="s.custom_model_link_instructions()" /></p>
    </section>
    <p class="guide-context"><RenderText :node="s.availability()" /></p>

    <section class="walkthrough-step" aria-labelledby="llama-guide-open">
      <h2 id="llama-guide-open">{{ s.open_model_manager_heading }}</h2>
      <p class="app-entry-intro"><RenderText :node="s.open_model_manager({ locale, destination: { kind: 'screen', screen: 'gguf-manager' } })" /></p>
      <p class="app-entry-onboarding"><RenderText :node="s.model_manager_first_run_note()" /></p>
      <p><RenderText :node="s.open_model_manager_instructions()" /></p>
      <figure class="guide-figure">
        <InBrowserModelSettingsStep mode="llama" stage="open" :messages="s" />
        <figcaption class="caption"><RenderText :node="s.open_model_manager_figure_caption()" /></figcaption>
      </figure>
    </section>

    <section class="walkthrough-step" aria-labelledby="llama-guide-import">
      <h2 id="llama-guide-import">{{ s.import_gguf_heading }}</h2>
      <p><RenderText :node="s.import_gguf_instructions()" /></p>
      <figure class="guide-figure">
        <InBrowserModelSettingsStep mode="llama" stage="import" :messages="s" />
        <figcaption class="caption"><RenderText :node="s.import_gguf_figure_caption()" /></figcaption>
      </figure>
    </section>

    <section class="walkthrough-step" aria-labelledby="llama-guide-download">
      <h2 id="llama-guide-download">{{ s.download_gguf_heading }}</h2>
      <p><RenderText :node="s.download_gguf_instructions()" /></p>
      <figure class="guide-figure">
        <InBrowserModelSettingsStep mode="llama" stage="download" :messages="s" />
        <figcaption class="caption">{{ s.download_gguf_figure_caption }}</figcaption>
      </figure>
    </section>

    <section class="walkthrough-step" aria-labelledby="llama-guide-default">
      <h2 id="llama-guide-default">{{ s.choose_default_model_heading }}</h2>
      <p><RenderText :node="s.choose_default_model_instructions()" /></p>
      <figure class="guide-figure">
        <InBrowserModelSettingsStep mode="llama" stage="default" :messages="s" />
        <figcaption class="caption">{{ s.choose_default_model_figure_caption }}</figcaption>
      </figure>
    </section>

    <p><RenderText :node="s.start_chat_after_setup()" /></p>

    <section aria-labelledby="llama-guide-large-gguf">
      <h2 id="llama-guide-large-gguf">{{ s.large_gguf_heading }}</h2>
      <p>{{ s.large_gguf_explanation }}</p>
    </section>

    <h2>{{ s.model_troubleshooting_heading }}</h2>
    <p><RenderText :node="s.model_troubleshooting()" /></p>
    <RelatedGuide :locale="locale" :eyebrow="common.related_guides" :guides="[
      { page: 'in-browser-models', title: s.browser_model_guide_title, description: s.browser_model_guide_description },
      { page: 'image-generation', title: s.image_generation_guide_title, description: s.image_generation_guide_description },
      { page: 'audio-generation', title: s.speech_generation_guide_title, description: s.speech_generation_guide_description },
    ]" />
  </article>
</template>

<style scoped>
.guide-context { padding:17px 20px;border-left:3px solid var(--blue);background:var(--surface);border-radius:0 10px 10px 0; }
.quick-models h2 { margin-bottom:10px; }
.quick-models > p { margin-top:0; }
.quick-model-list { display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px 12px;list-style:none;padding:0;margin:18px 0 32px; }
.quick-model-list li { min-width:0; }
.quick-model-list :deep(a) { display:flex;align-items:center;justify-content:space-between;gap:12px;width:100%;min-height:43px;padding:9px 12px;border:1px solid var(--line);border-radius:9px;background:var(--surface);color:var(--text);font-size:14px;font-weight:650;line-height:1.45;text-decoration:none;overflow-wrap:anywhere; }
.quick-model-list :deep(a::after) { content:'→';flex:none;color:var(--subtle);font-size:17px;line-height:1; }
.quick-model-list :deep(a:hover), .quick-model-list :deep(a:focus-visible) { border-color:var(--blue);background:var(--surface-2);color:var(--blue); }
.quick-model-list :deep(a:hover::after), .quick-model-list :deep(a:focus-visible::after) { color:var(--blue); }
.walkthrough-step { border-top:1px solid var(--line);margin-top:38px;padding-top:22px; }
.walkthrough-step h2 { margin-top:0; }
.walkthrough-step > p { margin-bottom:0; }
.walkthrough-step .guide-figure { margin:18px 0 0; }
.walkthrough-step figcaption { margin-inline:auto;max-width:660px; }
@media (max-width:620px) { .quick-model-list { grid-template-columns:1fr; } }
</style>
