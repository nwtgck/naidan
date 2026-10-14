<script setup lang="ts">
import UiText from '../../site/UiText.vue';
import BrowserModelSettingsStep from '../../site/demos/BrowserModelSettingsStep.vue';
import RelatedGuide from '../../site/RelatedGuide.vue';
import AppEntryLink from '../../site/AppEntryLink.vue';
import type { DocsLocale } from '../../site/routes';
import type { CommonMessages } from '../../site/messages';
import type { strings as english } from '../../pages/endpoint-type-llama-cpp-browser/strings/en';

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
    <p class="lead"><UiText :text="s.intro" /></p>
    <section class="quick-models" aria-labelledby="llama-guide-quick-models">
      <h2 id="llama-guide-quick-models">{{ s.quickModels.title }}</h2>
      <p><UiText :text="s.quickModels.body" /></p>
      <ul class="quick-model-list">
        <li v-for="item in quickModels" :key="item.model">
          <AppEntryLink :destination="{ kind: 'model', model: item.model }" :locale="locale" display="label">{{ item.name }}</AppEntryLink>
        </li>
      </ul>
      <p>{{ s.quickModels.ownLink.before }}<code>llama-cpp-browser-model</code>{{ s.quickModels.ownLink.middle }}<code>hf.co/owner/repository:Q4_K_M</code>{{ s.quickModels.ownLink.after }}</p>
    </section>
    <p class="guide-context"><UiText :text="s.availability" /></p>

    <section class="walkthrough-step" aria-labelledby="llama-guide-open">
      <h2 id="llama-guide-open">{{ s.steps.open.title }}</h2>
      <p class="app-entry-intro">{{ s.manager.before }}<AppEntryLink :destination="{ kind: 'screen', screen: 'gguf-manager' }" :locale="locale" display="path" />{{ s.manager.after }}</p>
      <p class="app-entry-onboarding"><UiText :text="s.manager.onboarding" /></p>
      <p><UiText :text="s.steps.open.body" /></p>
      <figure class="guide-figure">
        <BrowserModelSettingsStep mode="llama" stage="open" :copy="s.demo" />
        <figcaption class="caption"><UiText :text="s.steps.open.caption" /></figcaption>
      </figure>
    </section>

    <section class="walkthrough-step" aria-labelledby="llama-guide-import">
      <h2 id="llama-guide-import">{{ s.steps.import.title }}</h2>
      <p><UiText :text="s.steps.import.body" /></p>
      <figure class="guide-figure">
        <BrowserModelSettingsStep mode="llama" stage="import" :copy="s.demo" />
        <figcaption class="caption"><UiText :text="s.steps.import.caption" /></figcaption>
      </figure>
    </section>

    <section class="walkthrough-step" aria-labelledby="llama-guide-download">
      <h2 id="llama-guide-download">{{ s.steps.download.title }}</h2>
      <p><UiText :text="s.steps.download.body" /></p>
      <figure class="guide-figure">
        <BrowserModelSettingsStep mode="llama" stage="download" :copy="s.demo" />
        <figcaption class="caption"><UiText :text="s.steps.download.caption" /></figcaption>
      </figure>
    </section>

    <section class="walkthrough-step" aria-labelledby="llama-guide-default">
      <h2 id="llama-guide-default">{{ s.steps.default.title }}</h2>
      <p><UiText :text="s.steps.default.body" /></p>
      <figure class="guide-figure">
        <BrowserModelSettingsStep mode="llama" stage="default" :copy="s.demo" />
        <figcaption class="caption"><UiText :text="s.steps.default.caption" /></figcaption>
      </figure>
    </section>

    <p><UiText :text="s.startChat" /></p>

    <section aria-labelledby="llama-guide-large-gguf">
      <h2 id="llama-guide-large-gguf">{{ s.largeGguf.title }}</h2>
      <p>{{ s.largeGguf.body }}</p>
    </section>

    <h2>{{ s.noteTitle }}</h2>
    <p><UiText :text="s.note" /></p>
    <RelatedGuide :locale="locale" :eyebrow="common.relatedGuides" :guides="[
      { page: 'in-browser-models', title: s.next, description: s.nextDescription },
      { page: 'image-generation', ...s.related.image },
      { page: 'audio-generation', ...s.related.speech },
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
