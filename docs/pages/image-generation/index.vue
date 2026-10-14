<script setup lang="ts">
import RenderText from '../../components/RenderText';
import RelatedGuide from '../../components/RelatedGuide.vue';
import ImageCreationStep from '../../components/demos/ImageCreationStep.vue';
import type { CommonMessages, ImageCreateMessages } from '../../messages/types';
import type { DocsLocale } from '../../navigation/routes';

defineProps<{ s: ImageCreateMessages; locale: DocsLocale; common: CommonMessages }>();

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <article class="prose" data-testid="docs-images-create">
    <h1>{{ s.title }}</h1>
    <p class="lead">{{ s.make_your_first_image_with_a_local_model }}</p>
    <p class="app-entry-intro"><RenderText :node="s.start_in_the_image_workspace({ locale, destination: { kind: 'screen', screen: 'image-generation' } })" /></p>

    <section class="media-step" aria-labelledby="image-open">
      <h2 id="image-open">{{ s.open_the_image_workspace }}</h2>
      <p><RenderText :node="s.find_the_image_workspace()" /></p>
      <figure class="guide-figure"><ImageCreationStep stage="open" :messages="s" /><figcaption class="caption">{{ s.sidebar_opens_the_image_workspace }}</figcaption></figure>
    </section>

    <section class="media-step" aria-labelledby="image-model">
      <h2 id="image-model">{{ s.prepare_and_select_an_image_model }}</h2>
      <p><RenderText :node="s.choose_and_prepare_an_image_model()" /></p>
      <figure class="guide-figure"><ImageCreationStep stage="model" :messages="s" /><figcaption class="caption"><RenderText :node="s.return_with_a_prepared_model()" /></figcaption></figure>
    </section>

    <section class="media-step" aria-labelledby="image-generate">
      <h2 id="image-generate">{{ s.enter_a_prompt_and_generate_an_image }}</h2>
      <p><RenderText :node="s.generate_and_review_an_image()" /></p>
      <figure class="guide-figure"><ImageCreationStep stage="generate" :messages="s" /><figcaption class="caption">{{ s.image_generation_progress }}</figcaption></figure>
    </section>

    <section class="media-step" aria-labelledby="image-reuse">
      <h2 id="image-reuse">{{ s.inspect_and_try_another_version }}</h2>
      <p><RenderText :node="s.reuse_the_prompt_or_saved_settings()" /></p>
      <figure class="guide-figure"><ImageCreationStep stage="reuse" :messages="s" /><figcaption class="caption">{{ s.reuse_from_the_result_viewer }}</figcaption></figure>
    </section>

    <section class="media-note" aria-labelledby="image-storage"><h2 id="image-storage">{{ s.keep_work_for_later }}</h2><p><RenderText :node="s.image_session_storage_and_exports()" /></p></section>
    <section class="media-note" aria-labelledby="image-next"><h2 id="image-next">{{ s.after_your_first_image }}</h2><p>{{ s.more_ways_to_work_with_images }}</p></section>
    <RelatedGuide :locale="locale" :eyebrow="common.related_guides" :guides="[{ page: 'endpoint-type-llama-cpp-browser', title: s.run_a_gguf_model_in_your_browser, description: s.start_a_chat_with_a_local_gguf_model }]" />
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
