<script setup lang="ts">
import AudioCreationStep from '../../site/demos/AudioCreationStep.vue';
import type { AudioSpeechMessages } from '../../site/messages';

defineProps<{ s: AudioSpeechMessages }>();

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <article class="prose" data-testid="docs-audio-speech">
    <h1>{{ s.title }}</h1>
    <p class="lead">{{ s.intro }}</p>

    <section class="media-step" aria-labelledby="audio-open">
      <h2 id="audio-open">{{ s.steps.open.title }}</h2>
      <p>{{ s.steps.open.body }}</p>
      <figure class="guide-figure"><AudioCreationStep stage="open" :copy="s.demo" /><figcaption class="caption">{{ s.steps.open.caption }}</figcaption></figure>
    </section>

    <section class="media-step" aria-labelledby="audio-text">
      <h2 id="audio-text">{{ s.steps.text.title }}</h2>
      <p>{{ s.steps.text.body }}</p>
      <figure class="guide-figure"><AudioCreationStep stage="text" :copy="s.demo" /><figcaption class="caption">{{ s.steps.text.caption }}</figcaption></figure>
    </section>

    <section class="media-step" aria-labelledby="audio-generate">
      <h2 id="audio-generate">{{ s.steps.generate.title }}</h2>
      <p>{{ s.steps.generate.body }}</p>
      <figure class="guide-figure"><AudioCreationStep stage="generate" :copy="s.demo" /><figcaption class="caption">{{ s.steps.generate.caption }}</figcaption></figure>
    </section>

    <section class="media-step" aria-labelledby="audio-save">
      <h2 id="audio-save">{{ s.steps.save.title }}</h2>
      <p>{{ s.steps.save.body }}</p>
      <figure class="guide-figure"><AudioCreationStep stage="save" :copy="s.demo" /><figcaption class="caption">{{ s.steps.save.caption }}</figcaption></figure>
    </section>

    <section class="media-note" aria-labelledby="audio-reference"><h2 id="audio-reference">{{ s.referenceTitle }}</h2><p>{{ s.reference }}</p></section>
    <section class="media-note" aria-labelledby="audio-reading"><h2 id="audio-reading">{{ s.readingTitle }}</h2><p>{{ s.reading }}</p></section>
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
