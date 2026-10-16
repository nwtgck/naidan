<script setup lang="ts">
import RenderText from '../../components/RenderText';
import BackupSettingsStep from '../../components/demos/BackupSettingsStep.vue';
import RelatedGuide from '../../components/RelatedGuide.vue';
import type { DocsLocale } from '../../navigation/routes';
import type { BackupGuideMessages, CommonMessages } from '../../messages/types';

const { s } = defineProps<{ s: BackupGuideMessages; locale: DocsLocale; common: CommonMessages }>();

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <article class="prose" data-testid="docs-data-backup">
    <h1>{{ s.title }}</h1>
    <p class="lead"><RenderText :node="s.manual_zip_backup_overview()" /></p>
    <p class="app-entry-intro"><RenderText :node="s.open_naidan_to_back_up({ locale, destination: { kind: 'screen', screen: 'home' } })" /></p>

    <section class="walkthrough-step" aria-labelledby="backup-export">
      <h2 id="backup-export">{{ s.download_backup_zip_heading }}</h2>
      <p><RenderText :node="s.download_backup_zip_instructions()" /></p>
      <figure class="guide-figure">
        <BackupSettingsStep stage="export" :messages="s" />
        <figcaption class="caption">{{ s.export_options_caption }}</figcaption>
      </figure>
    </section>

    <section class="walkthrough-step" aria-labelledby="backup-preview">
      <h2 id="backup-preview">{{ s.inspect_archive_heading }}</h2>
      <p><RenderText :node="s.inspect_archive_instructions()" /></p>
      <figure class="guide-figure">
        <BackupSettingsStep stage="preview" :messages="s" />
        <figcaption class="caption">{{ s.archive_preview_caption }}</figcaption>
      </figure>
    </section>

    <section class="walkthrough-step" aria-labelledby="backup-mode">
      <h2 id="backup-mode">{{ s.choose_import_mode_heading }}</h2>
      <p v-for="(paragraph, index) in s.choose_import_mode_instructions()" :key="index"><RenderText :node="paragraph" /></p>
      <figure class="guide-figure">
        <BackupSettingsStep stage="mode" :messages="s" />
        <figcaption class="caption"><RenderText :node="s.import_mode_caption()" /></figcaption>
      </figure>
    </section>

    <section class="guide-scope" aria-labelledby="backup-scope">
      <h2 id="backup-scope">{{ s.zip_contents_heading }}</h2>
      <p><RenderText :node="s.zip_contents_and_exclusions()" /></p>
      <h2>{{ s.keep_backup_useful_heading }}</h2>
      <p>{{ s.keep_backup_useful_instructions }}</p>
    </section>
    <RelatedGuide :locale="locale" :eyebrow="common.related_guides" :guides="[{ page: 'data-storage', title: s.choose_conversation_storage_guide, description: s.compare_storage_provider_options }]" />
  </article>
</template>

<style scoped>
.walkthrough-step,.guide-scope {
  border-top: 1px solid var(--line);
  margin-top: 36px;
  padding-top: 22px;
}
.walkthrough-step h2,.guide-scope h2:first-child {
  margin-top: 0;
}
.walkthrough-step > p {
  margin-bottom: 0;
}
.walkthrough-step > p + p {
  margin-top: 1em;
}
.walkthrough-step .guide-figure {
  margin: 18px 0 0;
}
.walkthrough-step figcaption {
  margin-inline: auto;
  max-width: 670px;
}
</style>
