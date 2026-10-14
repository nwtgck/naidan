<script setup lang="ts">
import AppEntryLink from '../../site/AppEntryLink.vue';
import RelatedGuide from '../../site/RelatedGuide.vue';
import UiText from '../../site/UiText.vue';
import FileExplorerStep from '../../site/demos/FileExplorerStep.vue';
import type { DocsLocale } from '../../site/routes';
import type { CommonMessages, FileExplorerGuideMessages } from '../../site/messages';

defineProps<{ s: FileExplorerGuideMessages; locale: DocsLocale; common: CommonMessages }>();
defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <article class="prose" data-testid="docs-file-explorer">
    <h1>{{ s.title }}</h1>
    <p class="lead">{{ s.intro }}</p>
    <p class="app-entry-intro">{{ s.launch.before }}<AppEntryLink :destination="{ kind: 'screen', screen: 'home' }" :locale="locale" display="path" />{{ s.launch.after }}</p>
    <p><UiText :text="s.place" /></p>

    <section class="explorer-step" aria-labelledby="explorer-open">
      <h2 id="explorer-open">{{ s.steps.open.title }}</h2>
      <p><UiText :text="s.steps.open.body" /></p>
      <figure class="guide-figure"><FileExplorerStep stage="open" :copy="s.demo" /><figcaption class="caption"><UiText :text="s.steps.open.caption" /></figcaption></figure>
    </section>

    <section class="explorer-step" aria-labelledby="explorer-browse">
      <h2 id="explorer-browse">{{ s.steps.browse.title }}</h2>
      <p><UiText :text="s.steps.browse.body" /></p>
      <figure class="guide-figure"><FileExplorerStep stage="browse" :copy="s.demo" /><figcaption class="caption"><UiText :text="s.steps.browse.caption" /></figcaption></figure>
    </section>

    <section class="explorer-step" aria-labelledby="explorer-upload">
      <h2 id="explorer-upload">{{ s.steps.upload.title }}</h2>
      <p><UiText :text="s.steps.upload.body" /></p>
      <figure class="guide-figure"><FileExplorerStep stage="upload" :copy="s.demo" /><figcaption class="caption"><UiText :text="s.steps.upload.caption" /></figcaption></figure>
    </section>

    <section class="explorer-step" aria-labelledby="explorer-download">
      <h2 id="explorer-download">{{ s.steps.download.title }}</h2>
      <p><UiText :text="s.steps.download.body" /></p>
      <figure class="guide-figure"><FileExplorerStep stage="download" :copy="s.demo" /><figcaption class="caption"><UiText :text="s.steps.download.caption" /></figcaption></figure>
    </section>

    <section class="explorer-step" aria-labelledby="explorer-organize">
      <h2 id="explorer-organize">{{ s.steps.organize.title }}</h2>
      <p><UiText :text="s.steps.organize.body" /></p>
      <figure class="guide-figure"><FileExplorerStep stage="organize" :copy="s.demo" /><figcaption class="caption"><UiText :text="s.steps.organize.caption" /></figcaption></figure>
    </section>

    <RelatedGuide :locale="locale" :eyebrow="common.relatedGuides" :guides="[
      { page: 'file-access', title: s.related.files.title, description: s.related.files.description },
      { page: 'tool-browser-shell', title: s.related.shell.title, description: s.related.shell.description },
    ]" />
  </article>
</template>

<style scoped>
.explorer-step { border-top:1px solid var(--line);margin-top:36px;padding-top:22px; }
.explorer-step h2 { margin-top:0; }
.explorer-step > p { margin-bottom:0; }
.explorer-step .guide-figure { margin:18px 0 0; }
.explorer-step figcaption { margin-inline:auto;max-width:680px; }
</style>
