<script setup lang="ts">
import OfflineGuideStep from '../../components/demos/OfflineGuideStep.vue';
import RelatedGuide from '../../components/RelatedGuide.vue';
import RenderText from '../../components/RenderText';
import type { DocsLocale } from '../../navigation/routes';
import type { CommonMessages, OfflineGuideMessages } from '../../messages/types';

defineProps<{ s: OfflineGuideMessages; locale: DocsLocale; common: CommonMessages }>();

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <article class="prose" data-testid="docs-run-offline">
    <h1>{{ s.title }}</h1>
    <p class="lead">{{ s.introduction }}</p>
    <p class="app-entry-intro"><RenderText :node="s.open_hosted_app_online({ locale, destination: { kind: 'screen', screen: 'home' } })" /></p>

    <section class="walkthrough-step" aria-labelledby="offline-prepare">
      <h2 id="offline-prepare">{{ s.prepare_app_online_title }}</h2>
      <p>{{ s.prepare_app_online_instructions }}</p>
      <figure class="guide-figure">
        <OfflineGuideStep stage="prepare" :messages="s" />
        <figcaption class="caption">{{ s.saved_app_files_caption }}</figcaption>
      </figure>
      <p class="check-detail"><RenderText :node="s.offline_ready_event_guidance()" /></p>
    </section>

    <section class="walkthrough-step" aria-labelledby="offline-model">
      <h2 id="offline-model">{{ s.prepare_local_model_title }}</h2>
      <p>{{ s.prepare_local_model_instructions }}</p>
      <p><RenderText :node="s.gguf_model_setup_guidance({ locale })" /></p>
      <figure class="guide-figure">
        <OfflineGuideStep stage="model" :messages="s" />
        <figcaption class="caption">{{ s.separate_app_and_model_preparation_caption }}</figcaption>
      </figure>
    </section>

    <section class="walkthrough-step" aria-labelledby="offline-verify">
      <h2 id="offline-verify">{{ s.verify_offline_title }}</h2>
      <p>{{ s.verify_offline_instructions }}</p>
      <figure class="guide-figure">
        <OfflineGuideStep stage="verify" :messages="s" />
        <figcaption class="caption">{{ s.offline_verification_caption }}</figcaption>
      </figure>
      <p class="check-detail">{{ s.offline_feature_limitations }}</p>
    </section>

    <section class="walkthrough-step" aria-labelledby="offline-update">
      <h2 id="offline-update">{{ s.apply_update_title }}</h2>
      <p><RenderText :node="s.apply_prepared_update_instructions()" /></p>
      <figure class="guide-figure">
        <OfflineGuideStep stage="update" :messages="s" />
        <figcaption class="caption"><RenderText :node="s.update_preparation_caption()" /></figcaption>
      </figure>
      <p class="check-detail"><RenderText :node="s.early_update_warning()" /></p>
    </section>

    <section class="scope-section" aria-labelledby="offline-scope">
      <h2 id="offline-scope">{{ s.browser_storage_and_permissions_title }}</h2>
      <p>{{ s.browser_storage_and_permissions_explanation }}</p>
      <p>{{ s.standalone_alternative }}</p>
    </section>

    <RelatedGuide :locale="locale" :eyebrow="common.related_guides" :guides="[
      { page: 'endpoint-type-llama-cpp-browser', title: s.gguf_setup_guide_title, description: s.gguf_setup_guide_description },
      { page: 'in-browser-models', title: s.browser_models_guide_title, description: s.browser_models_guide_description },
      { page: 'standalone', title: s.standalone_guide_title, description: s.standalone_guide_description },
      { page: 'hosted', title: s.hosted_zip_guide_title, description: s.hosted_zip_guide_description },
    ]" />
  </article>
</template>

<style scoped>
.walkthrough-step {
  border-top: 1px solid var(--line);
  margin-top: 35px;
  padding-top: 24px;
}
.walkthrough-step h2 {
  margin-top: 0;
}
.walkthrough-step .guide-figure {
  margin: 21px 0 0;
}
.walkthrough-step figcaption {
  max-width: 680px;
}
.check-detail {
  margin: 17px 0 0;
  padding: 15px 18px;
  border-left: 3px solid var(--blue);
  border-radius: 0 10px 10px 0;
  background: var(--surface);
}
.scope-section {
  margin-top: 43px;
}
</style>
