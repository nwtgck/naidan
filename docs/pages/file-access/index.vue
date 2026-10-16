<script setup lang="ts">
import FolderAccessDemo from '../../components/demos/FolderAccessDemo.vue';
import RelatedGuide from '../../components/RelatedGuide.vue';
import RenderText from '../../components/RenderText';
import type { DocsLocale } from '../../navigation/routes';
import type { FilesMessages, CommonMessages } from '../../messages/types';

defineProps<{ s: FilesMessages; locale: DocsLocale; common: CommonMessages }>();


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
    data-testid="docs-files"
  >
    <h1>{{ s.title }}</h1>
    <p
      v-for="paragraph in s.intro()"
      :key="paragraph"
      class="lead"
    >{{ paragraph }}</p>
    <p class="app-entry-intro"><RenderText :node="s.launch_app_and_model_guide({ locale, destination: { kind: 'screen', screen: 'home' }, page: 'in-browser-models' })" /></p>
    <figure class="guide-figure"><FolderAccessDemo :messages="s" /><figcaption class="caption"><RenderText :node="s.folder_copy_caption()" /></figcaption></figure>
    <div class="pair-grid methods">
      <section
        v-for="(method, index) in [{ title: s.copy_folder_method_title, body: s.copy_folder_method_body }, { title: s.link_folder_method_title, body: s.link_folder_method_body }]"
        :key="index"
        class="panel"
      >
        <h2><RenderText :node="method.title()" /></h2>
        <p>{{ method.body }}</p>
      </section>
    </div>
    <h2>{{ s.read_and_write_permissions_title }}</h2>
    <p>{{ s.read_and_write_permissions_body }}</p>
    <p><RenderText :node="s.read_saved_files_with_shell({ locale, page: 'wesh-sysfs' })" /></p>
    <div class="decision-list"><section v-for="(item, index) in [{ title: s.choose_file_title, body: s.choose_file_body }, { title: s.choose_scope_title, body: s.choose_scope_body }, { title: s.check_destination_title, body: s.check_destination_body }]" :key="item.title"><span aria-hidden="true">0{{ index + 1 }}</span><div><h3>{{ item.title }}</h3><p>{{ item.body }}</p></div></section></div>
    <h2>{{ s.add_file_or_folder_title }}</h2>
    <ol>
      <li
        v-for="(step, index) in s.add_file_or_folder_steps()"
        :key="index"
      ><template v-if="typeof step === 'string'">{{ step }}</template><RenderText v-else :node="step" /></li>
    </ol>
    <RelatedGuide :locale="locale" :eyebrow="common.related_guides" :guides="[
      { page: 'file-explorer', title: s.file_explorer_guide_title, description: s.file_explorer_guide_description },
      { page: 'files-and-folders-settings', title: s.file_settings_guide_title, description: s.file_settings_guide_description },
      { page: 'browser-boundaries', title: s.browser_permissions_guide_title, description: s.browser_permissions_guide_description },
    ]" />
  </article>
</template>

<style scoped>
.methods {
  margin-top: 35px;
}

.methods h2 {
  font-size: 21px;
  margin-top: 0;
}
</style>
