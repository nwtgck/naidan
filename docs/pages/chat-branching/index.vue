<script setup lang="ts">
import RenderText from '../../components/RenderText';
import DocsIsland from '../../components/DocsIsland.vue';
import { branchingIsland } from '../../islands/branching/definition';
import RelatedGuide from '../../components/RelatedGuide.vue';
import type { DocsLocale } from '../../navigation/routes';
import type { BranchingMessages, CommonMessages } from '../../messages/types';

const { s } = defineProps<{ s: BranchingMessages; locale: DocsLocale; common: CommonMessages }>();


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
    data-testid="docs-branching"
  >
    <h1>{{ s.title }}</h1>
    <p class="lead">{{ s.choose_a_conversation_path }}</p>
    <p class="app-entry-intro"><RenderText :node="s.open_naidan_to_branch({ locale, destination: { kind: 'screen', screen: 'home' } })" /><RenderText :node="s.in_browser_model_setup_guide({ locale })" /></p>
    <h2>{{ s.create_and_switch_conversation_paths }}</h2>
    <ol>
      <li><RenderText :node="s.edit_resend_or_regenerate()" /></li>
      <li>{{ s.switch_message_versions }}</li>
      <li><RenderText :node="s.fork_into_a_separate_chat()" /></li>
    </ol>
    <h2>{{ s.try_each_way_to_branch }}</h2>
    <DocsIsland :entry="branchingIsland({ locale })" />
    <h2>{{ s.keep_versions_or_fork_chat }}</h2>
    <p><RenderText :node="s.how_versions_and_forks_differ()" /></p>
    <RelatedGuide :locale="locale" :eyebrow="common.related_guides" :guides="[{ page: 'chat-super-edit', title: s.rewrite_a_conversation_path, description: s.edit_and_reorder_a_path }]" />
  </article>
</template>
