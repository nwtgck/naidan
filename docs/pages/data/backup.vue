<script setup lang="ts">
import UiText from '../../site/UiText.vue';
import BackupSettingsStep from '../../site/demos/BackupSettingsStep.vue';
import { docsHref } from '../../site/routes';
import type { DocsLocale } from '../../site/routes';
import type { BackupGuideMessages, CommonMessages } from '../../site/messages';

defineProps<{ s: BackupGuideMessages; locale: DocsLocale; common: CommonMessages }>();

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <article class="prose" data-testid="docs-data-backup">
    <h1>{{ s.title }}</h1>
    <p class="lead"><UiText :text="s.intro" /></p>

    <section v-for="stage in (['export', 'preview', 'mode'] as const)" :key="stage" class="walkthrough-step" :aria-labelledby="`backup-${stage}`">
      <h2 :id="`backup-${stage}`">{{ s.steps[stage].title }}</h2>
      <p><UiText :text="s.steps[stage].body" /></p>
      <figure class="guide-figure">
        <BackupSettingsStep :stage="stage" :copy="s.demo" />
        <figcaption class="caption"><UiText :text="s.steps[stage].caption" /></figcaption>
      </figure>
    </section>

    <section class="guide-scope" aria-labelledby="backup-scope">
      <h2 id="backup-scope">{{ s.scopeTitle }}</h2>
      <p><UiText :text="s.scopeBody" /></p>
      <h2>{{ s.careTitle }}</h2>
      <p><UiText :text="s.careBody" /></p>
      <a class="next-link" :href="docsHref({ locale, page: 'data/storage' })">{{ s.storageLink }} <span aria-hidden="true">→</span></a>
    </section>
  </article>
</template>

<style scoped>
.walkthrough-step,.guide-scope { border-top:1px solid var(--line);margin-top:36px;padding-top:22px; }
.walkthrough-step h2,.guide-scope h2:first-child { margin-top:0; }
.walkthrough-step > p { margin-bottom:0; }
.walkthrough-step .guide-figure { margin:18px 0 0; }
.walkthrough-step figcaption { margin-inline:auto;max-width:670px; }
</style>
