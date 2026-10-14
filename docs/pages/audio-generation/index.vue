<script setup lang="ts">
import UiText from '../../site/UiText.vue';
import AppEntryLink from '../../site/AppEntryLink.vue';
import RelatedGuide from '../../site/RelatedGuide.vue';
import AudioCreationStep from '../../site/demos/AudioCreationStep.vue';
import type { AudioSpeechMessages, CommonMessages } from '../../site/messages';
import type { DocsLocale } from '../../site/routes';

defineProps<{ s: AudioSpeechMessages; locale: DocsLocale; common: CommonMessages }>();

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <article class="prose" data-testid="docs-audio-speech">
    <h1>{{ s.title }}</h1>
    <p class="lead"><UiText :text="s.intro" /></p>
    <p class="app-entry-intro">{{ s.launch.before }}<AppEntryLink :destination="{ kind: 'screen', screen: 'audio-generation' }" :locale="locale" display="path" />{{ s.launch.after }}</p>

    <section class="media-step" aria-labelledby="audio-open">
      <h2 id="audio-open">{{ s.steps.open.title }}</h2>
      <p><UiText :text="s.steps.open.body" /></p>
      <figure class="guide-figure"><AudioCreationStep stage="open" :copy="s.demo" /><figcaption class="caption"><UiText :text="s.steps.open.caption" /></figcaption></figure>
    </section>

    <section class="media-step" aria-labelledby="audio-text">
      <h2 id="audio-text">{{ s.steps.text.title }}</h2>
      <p><UiText :text="s.steps.text.body" /></p>
      <figure class="guide-figure"><AudioCreationStep stage="text" :copy="s.demo" /><figcaption class="caption"><UiText :text="s.steps.text.caption" /></figcaption></figure>
    </section>

    <section class="media-step" aria-labelledby="audio-generate">
      <h2 id="audio-generate">{{ s.steps.generate.title }}</h2>
      <p><UiText :text="s.steps.generate.body" /></p>
      <figure class="guide-figure"><AudioCreationStep stage="generate" :copy="s.demo" /><figcaption class="caption"><UiText :text="s.steps.generate.caption" /></figcaption></figure>
    </section>

    <section class="media-step" aria-labelledby="audio-save">
      <h2 id="audio-save">{{ s.steps.save.title }}</h2>
      <p><UiText :text="s.steps.save.body" /></p>
      <figure class="guide-figure"><AudioCreationStep stage="save" :copy="s.demo" /><figcaption class="caption"><UiText :text="s.steps.save.caption" /></figcaption></figure>
    </section>

    <section class="media-note" aria-labelledby="audio-reference"><h2 id="audio-reference">{{ s.referenceTitle }}</h2><p><UiText :text="s.reference" /></p></section>
    <section class="media-note" aria-labelledby="audio-reading"><h2 id="audio-reading">{{ s.readingTitle }}</h2><p><UiText :text="s.reading" /></p></section>
    <RelatedGuide :locale="locale" :eyebrow="common.relatedGuides" :guides="[{ page: 'endpoint-type-llama-cpp-browser', title: s.relatedTitle, description: s.relatedDescription }]" />
  </article>
</template>

<style scoped>
.media-step { border-top:1px solid var(--line);margin-top:36px;padding-top:22px; }
.media-step h2 { margin-top:0; }
.media-step > p { margin-bottom:0; }
.media-step .guide-figure { margin:18px 0 0; }
.media-step figcaption { margin-inline:auto;max-width:680px; }
.media-note { margin-top:40px; }
</style>
