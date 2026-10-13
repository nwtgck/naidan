<script setup lang="ts">
import StorageSettingsStep from '../../site/demos/StorageSettingsStep.vue';
import { docsHref } from '../../site/routes';
import type { DocsLocale } from '../../site/routes';
import type { CommonMessages, StorageGuideMessages } from '../../site/messages';

defineProps<{ s: StorageGuideMessages; locale: DocsLocale; common: CommonMessages }>();

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <article class="prose" data-testid="docs-data-storage">
    <h1>{{ s.title }}</h1>
    <p class="lead">{{ s.intro }}</p>

    <section v-for="stage in (['open', 'choose', 'persist'] as const)" :key="stage" class="walkthrough-step" :aria-labelledby="`storage-${stage}`">
      <h2 :id="`storage-${stage}`">{{ s.steps[stage].title }}</h2>
      <p>{{ s.steps[stage].body }}</p>
      <figure class="guide-figure">
        <StorageSettingsStep :stage="stage" :copy="s.demo" />
        <figcaption class="caption">{{ s.steps[stage].caption }}</figcaption>
      </figure>
    </section>

    <section class="guide-limits" aria-labelledby="storage-limits">
      <h2 id="storage-limits">{{ s.limitsTitle }}</h2>
      <ul><li v-for="item in s.limits" :key="item">{{ item }}</li></ul>
      <a class="next-link" :href="docsHref({ locale, page: 'data/backup' })">{{ s.backupLink }} <span aria-hidden="true">→</span></a>
    </section>
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
