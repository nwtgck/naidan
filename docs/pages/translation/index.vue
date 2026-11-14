<script setup lang="ts">
import RenderText from '../../components/RenderText';
import RelatedGuide from '../../components/RelatedGuide.vue';
import TranslationFlowDiagram from '../../components/demos/TranslationFlowDiagram.vue';
import TranslationGuideStep from '../../components/demos/TranslationGuideStep.vue';
import type { CommonMessages, TranslationGuideMessages } from '../../messages/types';
import type { DocsLocale } from '../../navigation/routes';

defineProps<{ s: TranslationGuideMessages; locale: DocsLocale; common: CommonMessages }>();
defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <article class="prose" data-testid="docs-translation">
    <h1>{{ s.title }}</h1>
    <p class="lead">{{ s.translate_text_on_this_device }}</p>
    <p class="app-entry-intro"><RenderText :node="s.open_the_translation_workspace({ locale, destination: { kind: 'screen', screen: 'translation' } })" /></p>
    <figure class="guide-figure"><TranslationFlowDiagram :messages="s" /><figcaption class="caption">{{ s.local_translation_flow }}</figcaption></figure>

    <section class="translation-step" aria-labelledby="translation-model">
      <h2 id="translation-model">{{ s.prepare_a_translation_model }}</h2>
      <p><RenderText :node="s.download_and_select_a_model()" /></p>
      <figure class="guide-figure"><TranslationGuideStep stage="model" :messages="s" /><figcaption class="caption">{{ s.model_demo_caption }}</figcaption></figure>
      <p><RenderText :node="s.use_a_model_you_already_have()" /></p>
      <p>{{ s.model_preparation_is_independent }}</p>
    </section>

    <section class="translation-step" aria-labelledby="translation-text">
      <h2 id="translation-text">{{ s.enter_text_and_copy_the_translation }}</h2>
      <p><RenderText :node="s.choose_languages_and_enter_text()" /></p>
      <p><RenderText :node="s.automatic_translation_starts_after_editing()" /></p>
      <figure class="guide-figure"><TranslationGuideStep stage="translate" :messages="s" /><figcaption class="caption">{{ s.translation_demo_caption }}</figcaption></figure>
    </section>

    <section class="translation-step" aria-labelledby="translation-wording">
      <h2 id="translation-wording">{{ s.guide_the_wording }}</h2>
      <p><RenderText :node="s.open_translation_options()" /></p>
      <figure class="guide-figure"><TranslationGuideStep stage="options" :messages="s" /><figcaption class="caption">{{ s.options_demo_caption }}</figcaption></figure>
      <p><RenderText :node="s.explain_reference_context()" /></p>
      <p><RenderText :node="s.explain_glossary()" /></p>
      <p><RenderText :node="s.explain_japanese_style()" /></p>
    </section>

    <section aria-labelledby="translation-timing">
      <h2 id="translation-timing">{{ s.choose_when_to_translate }}</h2>
      <p><RenderText :node="s.control_automatic_translation()" /></p>
    </section>

    <section aria-labelledby="translation-saving">
      <h2 id="translation-saving">{{ s.keep_the_text_you_need }}</h2>
      <p>{{ s.copy_before_leaving }}</p>
      <table data-testid="translation-storage"><thead><tr><th scope="col">{{ s.item }}</th><th scope="col">{{ s.what_remains }}</th></tr></thead><tbody><tr><th scope="row">{{ s.model_and_automatic_settings }}</th><td>{{ s.saved_in_settings }}</td></tr><tr><th scope="row">{{ s.language_choices }}</th><td>{{ s.kept_in_the_url }}</td></tr><tr><th scope="row">{{ s.entered_text_and_options }}</th><td>{{ s.kept_only_in_this_workspace }}</td></tr></tbody></table>
    </section>
    <RelatedGuide :locale="locale" :eyebrow="common.related_guides" :guides="[{ page: 'in-browser-model', title: s.prepare_models_for_offline_use, description: s.learn_about_model_files_and_storage }]" />
  </article>
</template>

<style scoped>
.translation-step {
  margin-top: 36px;
  padding-top: 22px;
  border-top: 1px solid var(--line);
}
.translation-step h2 {
  margin-top: 0;
}
.translation-step .guide-figure {
  margin: 20px 0;
}
table {
  width: 100%;
  table-layout: fixed;
}
th,td {
  overflow-wrap: anywhere;
}
thead th:first-child {
  width: 40%;
}
</style>
