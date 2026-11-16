<script setup lang="ts">
import RenderText from '../../components/RenderText';
import RelatedGuide from '../../components/RelatedGuide.vue';
import ImageUnderstandingGuideStep from '../../components/demos/ImageUnderstandingGuideStep.vue';
import type { CommonMessages, ImageUnderstandingGuideMessages } from '../../messages/types';
import type { DocsLocale } from '../../navigation/routes';

defineProps<{ s: ImageUnderstandingGuideMessages; locale: DocsLocale; common: CommonMessages }>();
defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <article class="prose" data-testid="docs-image-understanding">
    <h1>{{ s.title }}</h1>
    <p class="lead">{{ s.intro }}</p>
    <p class="app-entry-intro"><RenderText :node="s.open_chat({ locale, destination: { kind: 'screen', screen: 'home' } })" /></p>

    <section aria-labelledby="image-understanding-local">
      <h2 id="image-understanding-local">{{ s.local_processing_heading }}</h2>
      <p>{{ s.local_processing }}</p>
      <figure class="guide-figure"><ImageUnderstandingGuideStep stage="flow" :messages="s" :chrome="common" /><figcaption class="caption">{{ s.local_flow_caption }}</figcaption></figure>
    </section>

    <section class="walkthrough-step" aria-labelledby="image-understanding-prepare">
      <h2 id="image-understanding-prepare">{{ s.prepare_heading }}</h2>
      <p><RenderText :node="s.prepare_model()" /></p>
      <p><RenderText :node="s.select_companion()" /></p>
      <p><RenderText :node="s.start_model()" /></p>
      <figure class="guide-figure"><ImageUnderstandingGuideStep stage="model" :messages="s" :chrome="common" /><figcaption class="caption">{{ s.model_caption }}</figcaption></figure>
      <p><RenderText :node="s.local_files()" /></p>
    </section>

    <section class="walkthrough-step" aria-labelledby="image-understanding-attach">
      <h2 id="image-understanding-attach">{{ s.attach_heading }}</h2>
      <p><RenderText :node="s.attach_image()" /></p>
      <p>{{ s.paste_image }}</p>
      <figure class="guide-figure"><ImageUnderstandingGuideStep stage="attach" :messages="s" :chrome="common" /><figcaption class="caption">{{ s.attach_caption }}</figcaption></figure>
    </section>

    <section class="walkthrough-step" aria-labelledby="image-understanding-ask">
      <h2 id="image-understanding-ask">{{ s.ask_heading }}</h2>
      <p><RenderText :node="s.ask_question()" /></p>
      <figure class="guide-figure"><ImageUnderstandingGuideStep stage="ask" :messages="s" :chrome="common" /><figcaption class="caption">{{ s.photo_caption }}</figcaption></figure>
    </section>

    <section class="walkthrough-step" aria-labelledby="image-understanding-transcribe">
      <h2 id="image-understanding-transcribe">{{ s.transcribe_heading }}</h2>
      <p>{{ s.transcribe_instructions }}</p>
      <figure class="guide-figure"><ImageUnderstandingGuideStep stage="transcribe" :messages="s" :chrome="common" /><figcaption class="caption">{{ s.transcribe_caption }}</figcaption></figure>
    </section>

    <section class="walkthrough-step" aria-labelledby="image-understanding-table">
      <h2 id="image-understanding-table">{{ s.table_heading }}</h2>
      <p>{{ s.table_instructions }}</p>
      <figure class="guide-figure"><ImageUnderstandingGuideStep stage="table" :messages="s" :chrome="common" /><figcaption class="caption">{{ s.table_caption }}</figcaption></figure>
    </section>

    <section aria-labelledby="image-understanding-check"><h2 id="image-understanding-check">{{ s.check_heading }}</h2><p>{{ s.check_result }}</p></section>
    <section aria-labelledby="image-understanding-troubleshoot"><h2 id="image-understanding-troubleshoot">{{ s.troubleshooting_heading }}</h2><p><RenderText :node="s.troubleshoot()" /></p><p><RenderText :node="s.model_guide({ locale })" /></p><p><RenderText :node="s.other_tasks({ locale })" /></p></section>
    <RelatedGuide :locale="locale" :eyebrow="common.related_guides" :guides="[{ page: 'endpoint-type-llama-cpp-browser', title: s.related_model_title, description: s.related_model_description }, { page: 'file-access', title: s.related_files_title, description: s.related_files_description }]" />
  </article>
</template>

<style scoped>
.walkthrough-step {
  margin-top: 36px;
  padding-top: 22px;
  border-top: 1px solid var(--line);
}
.walkthrough-step h2 {
  margin-top: 0;
}
.guide-figure {
  margin: 20px 0;
}
</style>
