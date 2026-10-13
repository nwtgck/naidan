<script setup lang="ts">
import AppEntryLink from '../../site/AppEntryLink.vue';
import FilesSettingsStep from '../../site/demos/FilesSettingsStep.vue';
import RelatedGuide from '../../site/RelatedGuide.vue';
import UiText from '../../site/UiText.vue';
import type { DocsLocale } from '../../site/routes';
import type { CommonMessages, FilesSettingsGuideMessages } from '../../site/messages';

defineProps<{ s: FilesSettingsGuideMessages; locale: DocsLocale; common: CommonMessages }>();

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <article class="prose" data-testid="docs-files-settings">
    <h1>{{ s.title }}</h1>
    <p class="lead"><UiText :text="s.intro" /></p>
    <p class="launch-line">{{ s.launch }} <AppEntryLink :locale="locale" :destination="{ kind: 'screen', screen: 'files-settings' }" display="label">{{ s.filesLink }}</AppEntryLink> / <AppEntryLink :locale="locale" :destination="{ kind: 'screen', screen: 'folders-settings' }" display="label">{{ s.foldersLink }}</AppEntryLink> {{ s.launchEnd }}</p>

    <section v-for="stage in (['open', 'files', 'choose', 'copy', 'manage'] as const)" :key="stage" class="walkthrough-step" :aria-labelledby="`files-settings-${stage}`">
      <h2 :id="`files-settings-${stage}`">{{ s.steps[stage].title }}</h2>
      <p><UiText :text="s.steps[stage].body" /></p>
      <figure class="guide-figure">
        <FilesSettingsStep :stage="stage" :copy="s.demo" />
        <figcaption class="caption"><UiText :text="s.steps[stage].caption" /></figcaption>
      </figure>
    </section>

    <section class="guide-scope" aria-labelledby="files-settings-scope">
      <h2 id="files-settings-scope">{{ s.afterTitle }}</h2>
      <p><UiText :text="s.after" /></p>
    </section>
    <RelatedGuide :locale="locale" :eyebrow="common.relatedGuides" :guides="[
      { page: 'files/privacy', title: s.relatedPrivacy, description: s.relatedPrivacyDescription },
      { page: 'work/browser-shell', title: s.relatedShell, description: s.relatedShellDescription },
    ]" />
  </article>
</template>

<style scoped>
.launch-line { padding:14px 18px;border-left:3px solid var(--blue);border-radius:0 10px 10px 0;background:var(--surface); }
.launch-line a { font-weight:750;overflow-wrap:anywhere; }
.walkthrough-step,.guide-scope { border-top:1px solid var(--line);margin-top:36px;padding-top:22px; }
.walkthrough-step h2,.guide-scope h2:first-child { margin-top:0; }
.walkthrough-step > p { margin-bottom:0; }
.walkthrough-step .guide-figure { margin:18px 0 0; }
.walkthrough-step figcaption { margin-inline:auto;max-width:670px; }
</style>
