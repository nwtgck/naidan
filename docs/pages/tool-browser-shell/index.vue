<script setup lang="ts">
import ShellWorkspaceDemo from '../../components/demos/ShellWorkspaceDemo.vue';
import ShellEnableStep from '../../components/demos/ShellEnableStep.vue';
import RelatedGuide from '../../components/RelatedGuide.vue';
import RenderText from '../../components/RenderText';
import type { DocsLocale } from '../../navigation/routes';
import type { CommonMessages, ShellMessages } from '../../messages/types';

defineProps<{ s: ShellMessages; locale: DocsLocale; common: CommonMessages }>();


defineExpose({
  ...((__BUILD_MODE_IS_TEST__ && {
    TEST_ONLY: {
      // Export internal state and logic used only for testing here. Do not reference these in production logic.
      // ESLint-required for defineExpose.
    },
  }) || {}),
});
</script>

<template>
  <article
    class="prose"
    data-testid="docs-shell"
  >
    <h1>{{ s.title }}</h1>
    <p
      v-for="paragraph in s.intro()"
      :key="paragraph"
      class="lead"
    >{{ paragraph }}</p>
    <p class="app-entry-intro"><RenderText :node="s.open_shell_chat({ locale, destination: { kind: 'screen', screen: 'home' } })" /></p>
    <p class="prerequisite"><RenderText :node="s.choose_tool_capable_model({ locale, browserPage: 'in-browser-models', enginePage: 'local-ai-servers', modelDestination: { kind: 'model', model: 'hf.co/lmstudio-community/Qwen3.5-9B-GGUF:Q4_K_M' } })" /></p>
    <figure class="guide-figure"><ShellWorkspaceDemo :messages="s" :common="common" /><figcaption class="caption">{{ s.shell_task_example_caption }}</figcaption></figure>
    <section class="shell-walkthrough" data-testid="docs-shell-walkthrough">
      <h2>{{ s.enable_shell_title }}</h2>
      <section class="shell-walkthrough-step">
        <h3>{{ s.open_chat_tools_title }}</h3>
        <p><RenderText :node="s.open_chat_tools_body()" /></p>
        <figure class="guide-figure"><ShellEnableStep stage="open" :messages="s" /><figcaption class="caption"><RenderText :node="s.open_chat_tools_caption()" /></figcaption></figure>
      </section>
      <section class="shell-walkthrough-step">
        <h3>{{ s.turn_on_shell_title }}</h3>
        <p><RenderText :node="s.turn_on_shell_body()" /></p>
        <figure class="guide-figure"><ShellEnableStep stage="enable" :messages="s" /><figcaption class="caption"><RenderText :node="s.turn_on_shell_caption()" /></figcaption></figure>
        <p><RenderText :node="s.shell_mount_guide({ locale, page: 'wesh-sysfs' })" /></p>
      </section>
      <p><RenderText :node="s.choose_working_folder_guide({ locale, page: 'file-access' })" /></p>
    </section>
    <section
      v-for="section in [{ title: s.browser_filesystem_section_title, body: s.browser_filesystem_section_body }, { title: s.shell_folder_access_title, body: s.shell_folder_access_body }]"
      :key="section.title"
    >
      <h2>{{ section.title }}</h2>
      <p>{{ section.body }}</p>
    </section>
    <section>
      <h2>{{ s.browser_commands_title }}</h2>
      <p>{{ s.browser_commands_intro }}</p>
      <ul class="shell-command-list" data-testid="docs-shell-command-list">
        <li v-for="group in [{ title: s.find_and_organize_files_title, names: s.find_and_organize_files_names(), body: s.find_and_organize_files_body }, { title: s.search_and_process_text_title, names: s.search_and_process_text_names(), body: s.search_and_process_text_body }, { title: s.extract_structured_data_title, names: s.extract_structured_data_names(), body: s.extract_structured_data_body }, { title: s.pack_and_unpack_files_title, names: s.pack_and_unpack_files_names(), body: s.pack_and_unpack_files_body }, { title: s.compare_and_check_files_title, names: s.compare_and_check_files_names(), body: s.compare_and_check_files_body }, { title: s.review_changes_with_git_title, names: s.review_changes_with_git_names(), body: s.review_changes_with_git_body }]" :key="group.title">
          <strong>{{ group.title }}</strong>
          <span class="shell-command-names"><code v-for="name in group.names" :key="name">{{ name }}</code></span>
          <p>{{ group.body }}</p>
        </li>
      </ul>
      <p class="caption">{{ s.browser_commands_help }} <code>help</code> · <code>help grep</code> · <code>grep --help</code></p>
    </section>
    <RelatedGuide :locale="locale" :eyebrow="common.related_guides" :guides="[
      { page: 'file-access', title: s.file_access_guide_title, description: s.file_access_guide_description },
      { page: 'tool-wikipedia', title: s.wikipedia_guide_title, description: s.wikipedia_guide_description },
    ]" />
  </article>
</template>

<style scoped>
.shell-command-list {
  padding-left: 1.3em;
}
.shell-command-list li {
  min-width: 0;
  margin-block: 18px;
  overflow-wrap: anywhere;
}
.shell-command-names {
  display: flex;
  flex-wrap: wrap;
  gap: 5px 12px;
  margin-top: 4px;
}
.shell-command-names code {
  font-size: .85em;
  overflow-wrap: anywhere;
}
.shell-command-list p {
  margin: 4px 0 0;
}
.shell-walkthrough {
  margin-block: 35px 45px;
}
.shell-walkthrough-step {
  margin-top: 25px;
}
.shell-walkthrough-step .guide-figure {
  margin-top: 16px;
}
</style>
