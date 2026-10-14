<script setup lang="ts">
import RenderText from '../../components/RenderText';
import StorageSettingsStep from '../../components/demos/StorageSettingsStep.vue';
import RelatedGuide from '../../components/RelatedGuide.vue';
import type { DocsLocale } from '../../navigation/routes';
import type { CommonMessages, StorageGuideMessages } from '../../messages/types';

const { s } = defineProps<{ s: StorageGuideMessages; locale: DocsLocale; common: CommonMessages }>();

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <article class="prose" data-testid="docs-data-storage">
    <h1>{{ s.title }}</h1>
    <p class="lead"><RenderText :node="s.choose_conversation_storage()" /></p>
    <p class="app-entry-intro"><RenderText :node="s.open_storage_settings({ locale, destination: { kind: 'screen', screen: 'home' } })" /></p>

    <section class="walkthrough-step" aria-labelledby="storage-open">
      <h2 id="storage-open">{{ s.open_storage_settings_heading }}</h2>
      <p><RenderText :node="s.open_storage_settings_instructions()" /></p>
      <figure class="guide-figure">
        <StorageSettingsStep stage="open" :messages="s" />
        <figcaption class="caption"><RenderText :node="s.storage_navigation_caption()" /></figcaption>
      </figure>
    </section>

    <section class="walkthrough-step" aria-labelledby="storage-choose">
      <h2 id="storage-choose">{{ s.choose_storage_provider_heading }}</h2>
      <p><RenderText :node="s.choose_storage_provider_instructions()" /></p>
      <figure class="guide-figure">
        <StorageSettingsStep stage="choose" :messages="s" />
        <figcaption class="caption"><RenderText :node="s.switch_provider_caption()" /></figcaption>
      </figure>
    </section>

    <section class="walkthrough-step" aria-labelledby="storage-persist">
      <h2 id="storage-persist">{{ s.request_persistent_storage_heading }}</h2>
      <p><RenderText :node="s.request_persistent_storage_instructions()" /></p>
      <figure class="guide-figure">
        <StorageSettingsStep stage="persist" :messages="s" />
        <figcaption class="caption"><RenderText :node="s.persistent_storage_request_caption()" /></figcaption>
      </figure>
    </section>

    <section class="guide-limits" aria-labelledby="storage-limits">
      <h2 id="storage-limits">{{ s.before_relying_on_one_browser_copy }}</h2>
      <ul><li>{{ s.browser_data_loss_risks }}</li><li><RenderText :node="s.provider_switching_limits()" /></li><li><RenderText :node="s.ephemeral_storage_limits()" /></li></ul>
    </section>
    <RelatedGuide :locale="locale" :eyebrow="common.related_guides" :guides="[{ page: 'data-backup', title: s.backup_conversations_guide, description: s.export_and_restore_a_zip }]" />
  </article>
</template>

<style scoped>
.walkthrough-step,.guide-limits { border-top:1px solid var(--line);margin-top:36px;padding-top:22px; }
.walkthrough-step h2,.guide-limits h2 { margin-top:0; }
.walkthrough-step > p { margin-bottom:0; }
.walkthrough-step .guide-figure { margin:18px 0 0; }
.walkthrough-step figcaption { margin-inline:auto;max-width:670px; }
.guide-limits ul { padding-left:1.4em; }
.guide-limits li { margin:10px 0; }
</style>
