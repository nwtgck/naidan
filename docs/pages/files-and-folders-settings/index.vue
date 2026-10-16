<script setup lang="ts">
import FilesSettingsStep from '../../components/demos/FilesSettingsStep.vue';
import RelatedGuide from '../../components/RelatedGuide.vue';
import RenderText from '../../components/RenderText';
import { computed } from 'vue';
import type { DocsLocale } from '../../navigation/routes';
import type { CommonMessages, FilesSettingsGuideMessages } from '../../messages/types';

const props = defineProps<{ s: FilesSettingsGuideMessages; locale: DocsLocale; common: CommonMessages }>();
const stages = computed(() => ([
  { stage: 'open', title: props.s.open_settings_title, body: props.s.open_settings_body(), caption: props.s.open_settings_caption },
  { stage: 'files', title: props.s.inspect_saved_files_title, body: props.s.inspect_saved_files_body(), caption: props.s.inspect_saved_files_caption },
  { stage: 'choose', title: props.s.link_working_folder_title, body: props.s.link_working_folder_body(), caption: props.s.link_working_folder_caption },
  { stage: 'copy', title: props.s.copy_working_folder_title, body: props.s.copy_working_folder_body(), caption: props.s.copy_working_folder_caption },
  { stage: 'manage', title: props.s.manage_working_folder_title, body: props.s.manage_working_folder_body(), caption: props.s.manage_working_folder_caption },
] as const));

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <article class="prose" data-testid="docs-files-settings">
    <h1>{{ s.title }}</h1>
    <p class="lead"><RenderText :node="s.intro()" /></p>
    <p class="launch-line"><RenderText :node="s.open_file_and_folder_settings({ locale, filesDestination: { kind: 'screen', screen: 'files-settings' }, foldersDestination: { kind: 'screen', screen: 'folders-settings' } })" /></p>

    <section v-for="step in stages" :key="step.stage" class="walkthrough-step" :aria-labelledby="`files-settings-${step.stage}`">
      <h2 :id="`files-settings-${step.stage}`">{{ step.title }}</h2>
      <p><RenderText :node="step.body" /></p>
      <figure class="guide-figure">
        <FilesSettingsStep :stage="step.stage" :messages="s" />
        <figcaption class="caption">{{ step.caption }}</figcaption>
      </figure>
      <p v-if="step.stage === 'files'"><RenderText :node="s.saved_files_shell_access({ locale, page: 'wesh-sysfs' })" /></p>
    </section>

    <section class="guide-scope" aria-labelledby="files-settings-scope">
      <h2 id="files-settings-scope">{{ s.after_adding_a_folder_title }}</h2>
      <p>{{ s.after_adding_a_folder }}</p>
    </section>
    <RelatedGuide :locale="locale" :eyebrow="common.related_guides" :guides="[
      { page: 'file-access', title: s.file_access_guide, description: s.file_access_guide_description },
      { page: 'tool-browser-shell', title: s.shell_guide, description: s.shell_guide_description },
    ]" />
  </article>
</template>

<style scoped>
.launch-line {
  padding: 14px 18px;
  border-left: 3px solid var(--blue);
  border-radius: 0 10px 10px 0;
  background: var(--surface);
}
.launch-line a {
  font-weight: 750;
  overflow-wrap: anywhere;
}
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
.walkthrough-step .guide-figure {
  margin: 18px 0 0;
}
.walkthrough-step figcaption {
  margin-inline: auto;
  max-width: 670px;
}
</style>
