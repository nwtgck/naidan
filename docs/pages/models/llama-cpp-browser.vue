<script setup lang="ts">
import UiText from '../../site/UiText.vue';
import BrowserModelSettingsStep from '../../site/demos/BrowserModelSettingsStep.vue';
import RelatedGuide from '../../site/RelatedGuide.vue';
import type { DocsLocale } from '../../site/routes';
import type { CommonMessages } from '../../site/messages';
import type { strings as english } from '../../strings/models/llama-cpp-browser/en';

defineProps<{ s: typeof english; locale: DocsLocale; common: CommonMessages }>();

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <article class="prose" data-testid="docs-models-llama-cpp-browser">
    <h1>{{ s.title }}</h1>
    <p class="lead"><UiText :text="s.intro" /></p>
    <p class="guide-context"><UiText :text="s.availability" /></p>

    <section class="walkthrough-step" aria-labelledby="llama-guide-open">
      <h2 id="llama-guide-open">{{ s.steps.open.title }}</h2>
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

    <section aria-labelledby="llama-guide-large-gguf">
      <h2 id="llama-guide-large-gguf">{{ s.largeGguf.title }}</h2>
      <p>{{ s.largeGguf.body }}</p>
    </section>

    <h2>{{ s.noteTitle }}</h2>
    <p><UiText :text="s.note" /></p>
    <RelatedGuide :locale="locale" :eyebrow="common.relatedGuides" :guides="[{ page: 'models/in-browser', title: s.next, description: s.nextDescription }]" />
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
