<script setup lang="ts">
import RelatedGuide from '../../components/RelatedGuide.vue';
import RenderText from '../../components/RenderText';
import FileExplorerStep from '../../components/demos/FileExplorerStep.vue';
import type { DocsLocale } from '../../navigation/routes';
import type { CommonMessages, FileExplorerGuideMessages } from '../../messages/types';

defineProps<{ s: FileExplorerGuideMessages; locale: DocsLocale; common: CommonMessages }>();
defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <article class="prose" data-testid="docs-file-explorer">
    <h1>{{ s.title }}</h1>
    <p class="lead">{{ s.intro }}</p>
    <p class="app-entry-intro"><RenderText :node="s.open_file_explorer({ locale, destination: { kind: 'screen', screen: 'home' } })" /></p>
    <p><RenderText :node="s.where_file_explorer_opens()" /></p>

    <section class="explorer-step" aria-labelledby="explorer-open">
      <h2 id="explorer-open">{{ s.open_location_title }}</h2>
      <p><RenderText :node="s.open_location_body()" /></p>
      <figure class="guide-figure"><FileExplorerStep stage="open" :messages="s" /><figcaption class="caption"><RenderText :node="s.open_location_caption()" /></figcaption></figure>
    </section>

    <section class="explorer-step" aria-labelledby="explorer-browse">
      <h2 id="explorer-browse">{{ s.browse_files_title }}</h2>
      <p><RenderText :node="s.browse_files_body()" /></p>
      <figure class="guide-figure"><FileExplorerStep stage="browse" :messages="s" /><figcaption class="caption">{{ s.browse_files_caption }}</figcaption></figure>
    </section>

    <section class="explorer-step" aria-labelledby="explorer-upload">
      <h2 id="explorer-upload">{{ s.upload_files_title }}</h2>
      <p><RenderText :node="s.upload_files_body()" /></p>
      <figure class="guide-figure"><FileExplorerStep stage="upload" :messages="s" /><figcaption class="caption">{{ s.upload_files_caption }}</figcaption></figure>
    </section>

    <section class="explorer-step" aria-labelledby="explorer-download">
      <h2 id="explorer-download">{{ s.download_files_title }}</h2>
      <p><RenderText :node="s.download_files_body()" /></p>
      <figure class="guide-figure"><FileExplorerStep stage="download" :messages="s" /><figcaption class="caption">{{ s.download_files_caption }}</figcaption></figure>
    </section>

    <section class="explorer-step" aria-labelledby="explorer-organize">
      <h2 id="explorer-organize">{{ s.organize_files_title }}</h2>
      <p><RenderText :node="s.organize_files_body()" /></p>
      <figure class="guide-figure"><FileExplorerStep stage="organize" :messages="s" /><figcaption class="caption">{{ s.organize_files_caption }}</figcaption></figure>
    </section>

    <RelatedGuide :locale="locale" :eyebrow="common.related_guides" :guides="[
      { page: 'file-access', title: s.file_access_guide_title, description: s.file_access_guide_description },
      { page: 'tool-browser-shell', title: s.shell_guide_title, description: s.shell_guide_description },
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
