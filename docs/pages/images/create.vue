<script setup lang="ts">
import UiText from '../../site/UiText.vue';
import AppEntryLink from '../../site/AppEntryLink.vue';
import RelatedGuide from '../../site/RelatedGuide.vue';
import ImageCreationStep from '../../site/demos/ImageCreationStep.vue';
import type { CommonMessages, ImageCreateMessages } from '../../site/messages';
import type { DocsLocale } from '../../site/routes';

defineProps<{ s: ImageCreateMessages; locale: DocsLocale; common: CommonMessages }>();

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <article class="prose" data-testid="docs-images-create">
    <h1>{{ s.title }}</h1>
    <p class="lead"><UiText :text="s.intro" /></p>
    <p class="app-entry-intro">{{ s.launch.before }}<AppEntryLink :destination="{ kind: 'screen', screen: 'image-generation' }" :locale="locale" display="path" />{{ s.launch.after }}</p>

    <section class="media-step" aria-labelledby="image-open">
      <h2 id="image-open">{{ s.steps.open.title }}</h2>
      <p><UiText :text="s.steps.open.body" /></p>
      <figure class="guide-figure"><ImageCreationStep stage="open" :copy="s.demo" /><figcaption class="caption"><UiText :text="s.steps.open.caption" /></figcaption></figure>
    </section>

    <section class="media-step" aria-labelledby="image-model">
      <h2 id="image-model">{{ s.steps.model.title }}</h2>
      <p><UiText :text="s.steps.model.body" /></p>
      <figure class="guide-figure"><ImageCreationStep stage="model" :copy="s.demo" /><figcaption class="caption"><UiText :text="s.steps.model.caption" /></figcaption></figure>
    </section>

    <section class="media-step" aria-labelledby="image-generate">
      <h2 id="image-generate">{{ s.steps.generate.title }}</h2>
      <p><UiText :text="s.steps.generate.body" /></p>
      <figure class="guide-figure"><ImageCreationStep stage="generate" :copy="s.demo" /><figcaption class="caption"><UiText :text="s.steps.generate.caption" /></figcaption></figure>
    </section>

    <section class="media-step" aria-labelledby="image-reuse">
      <h2 id="image-reuse">{{ s.steps.reuse.title }}</h2>
      <p><UiText :text="s.steps.reuse.body" /></p>
      <figure class="guide-figure"><ImageCreationStep stage="reuse" :copy="s.demo" /><figcaption class="caption"><UiText :text="s.steps.reuse.caption" /></figcaption></figure>
    </section>

    <section class="media-note" aria-labelledby="image-storage"><h2 id="image-storage">{{ s.storageTitle }}</h2><p><UiText :text="s.storage" /></p></section>
    <section class="media-note" aria-labelledby="image-next"><h2 id="image-next">{{ s.nextTitle }}</h2><p><UiText :text="s.next" /></p></section>
    <RelatedGuide :locale="locale" :eyebrow="common.relatedGuides" :guides="[{ page: 'models/llama-cpp-browser', title: s.relatedTitle, description: s.relatedDescription }]" />
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
