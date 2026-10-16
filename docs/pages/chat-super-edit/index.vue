<script setup lang="ts">
import RenderText from '../../components/RenderText';
import SuperEditStep from '../../components/demos/SuperEditStep.vue';
import RelatedGuide from '../../components/RelatedGuide.vue';
import type { CommonMessages, SuperEditMessages } from '../../messages/types';
import type { DocsLocale } from '../../navigation/routes';

const { s } = defineProps<{ s: SuperEditMessages; locale: DocsLocale; common: CommonMessages }>();
defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <article class="prose" data-testid="docs-chat-super-edit">
    <h1>{{ s.title }}</h1>
    <p class="lead"><RenderText :node="s.reshape_conversation_path()" /></p>
    <p class="app-entry-intro"><RenderText :node="s.open_chat_for_super_edit({ locale, destination: { kind: 'screen', screen: 'home' } })" /></p>

    <section class="walkthrough-step" aria-labelledby="super-edit-open">
      <h2 id="super-edit-open">{{ s.open_history_editor_heading }}</h2>
      <p><RenderText :node="s.open_history_editor_instructions()" /></p>
      <figure class="guide-figure"><SuperEditStep stage="open" :messages="s" /><figcaption class="caption"><RenderText :node="s.history_editor_menu_caption()" /></figcaption></figure>
    </section>

    <section class="walkthrough-step" aria-labelledby="super-edit-edit">
      <h2 id="super-edit-edit">{{ s.shape_message_list_heading }}</h2>
      <p><RenderText :node="s.shape_message_list_instructions()" /></p>
      <figure class="guide-figure"><SuperEditStep stage="edit" :messages="s" /><figcaption class="caption">{{ s.message_editor_caption }}</figcaption></figure>
    </section>

    <section class="walkthrough-step" aria-labelledby="super-edit-prompt">
      <h2 id="super-edit-prompt">{{ s.check_chat_system_prompt_heading }}</h2>
      <p><RenderText :node="s.check_chat_system_prompt_instructions()" /></p>
      <figure class="guide-figure"><SuperEditStep stage="prompt" :messages="s" /><figcaption class="caption"><RenderText :node="s.system_prompt_choices_caption()" /></figcaption></figure>
    </section>

    <section class="walkthrough-step" aria-labelledby="super-edit-apply">
      <h2 id="super-edit-apply">{{ s.apply_new_path_heading }}</h2>
      <p><RenderText :node="s.apply_new_path_instructions()" /></p>
      <figure class="guide-figure"><SuperEditStep stage="apply" :messages="s" /><figcaption class="caption">{{ s.new_path_caption }}</figcaption></figure>
    </section>

    <h2>{{ s.choose_change_scope_heading }}</h2>
    <p>{{ s.small_change_or_super_edit }}</p>
    <RelatedGuide :locale="locale" :eyebrow="common.related_guides" :guides="[{ page: 'chat-branching', title: s.branch_and_edit_conversations, description: s.use_versions_or_fork_for_small_change }]" />
  </article>
</template>

<style scoped>
.walkthrough-step {
  border-top: 1px solid var(--line);
  margin-top: 38px;
  padding-top: 22px;
}
.walkthrough-step h2 {
  margin-top: 0;
}
.walkthrough-step > p {
  margin-bottom: 0;
}
.walkthrough-step .guide-figure {
  margin: 18px 0 0;
}
</style>
