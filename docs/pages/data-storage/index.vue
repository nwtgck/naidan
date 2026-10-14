<script setup lang="ts">
import UiText from '../../site/UiText.vue';
import AppEntryLink from '../../site/AppEntryLink.vue';
import StorageSettingsStep from '../../site/demos/StorageSettingsStep.vue';
import RelatedGuide from '../../site/RelatedGuide.vue';
import type { DocsLocale } from '../../site/routes';
import type { CommonMessages, StorageGuideMessages } from '../../site/messages';

defineProps<{ s: StorageGuideMessages; locale: DocsLocale; common: CommonMessages }>();

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <article class="prose" data-testid="docs-data-storage">
    <h1>{{ s.title }}</h1>
    <p class="lead"><UiText :text="s.intro" /></p>
    <p class="app-entry-intro">{{ s.launch.before }}<AppEntryLink :destination="{ kind: 'screen', screen: 'home' }" :locale="locale" display="path" /><UiText :text="s.launch.after" /></p>

    <section v-for="stage in (['open', 'choose', 'persist'] as const)" :key="stage" class="walkthrough-step" :aria-labelledby="`storage-${stage}`">
      <h2 :id="`storage-${stage}`">{{ s.steps[stage].title }}</h2>
      <p><UiText :text="s.steps[stage].body" /></p>
      <figure class="guide-figure">
        <StorageSettingsStep :stage="stage" :copy="s.demo" />
        <figcaption class="caption"><UiText :text="s.steps[stage].caption" /></figcaption>
      </figure>
    </section>

    <section class="guide-limits" aria-labelledby="storage-limits">
      <h2 id="storage-limits">{{ s.limitsTitle }}</h2>
      <ul><li v-for="item in s.limits" :key="item"><UiText :text="item" /></li></ul>
    </section>
    <RelatedGuide :locale="locale" :eyebrow="common.relatedGuides" :guides="[{ page: 'data-backup', title: s.backupLink, description: s.nextDescription }]" />
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
