<script setup lang="ts">
import RenderText from '../../components/RenderText';
import CompactStep from '../../components/demos/CompactStep.vue';
import RelatedGuide from '../../components/RelatedGuide.vue';
import type { DocsLocale } from '../../navigation/routes';
import type { CommonMessages } from '../../messages/types';
import type { messages as compactMessages } from './messages/en';

const { s } = defineProps<{ s: typeof compactMessages; locale: DocsLocale; common: CommonMessages }>();

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <article class="prose" data-testid="docs-chat-compact">
    <h1>{{ s.title }}</h1>
    <p class="lead"><RenderText :node="s.shorten_a_long_conversation()" /></p>
    <p class="app-entry-intro"><RenderText :node="s.open_chat_to_compact({ locale, destination: { kind: 'screen', screen: 'home' } })" /></p>
    <p class="prerequisite">{{ s.check_model_and_summary }} <RenderText :node="s.model_setup_guides({ locale })" /></p>

    <section class="walkthrough-step" aria-labelledby="compact-open">
      <h2 id="compact-open">{{ s.open_compact_context_heading }}</h2>
      <p><RenderText :node="s.open_compact_context_instructions()" /></p>
      <figure class="guide-figure">
        <CompactStep stage="open" :messages="s" />
        <figcaption class="caption"><RenderText :node="s.compact_context_menu_caption()" /></figcaption>
      </figure>
    </section>

    <section class="walkthrough-step" aria-labelledby="compact-keep">
      <h2 id="compact-keep">{{ s.choose_recent_messages_heading }}</h2>
      <p><RenderText :node="s.choose_recent_messages_instructions()" /></p>
      <figure class="guide-figure">
        <CompactStep stage="keep" :messages="s" />
        <figcaption class="caption">{{ s.recent_messages_selection_caption }}</figcaption>
      </figure>
    </section>

    <section class="walkthrough-step" aria-labelledby="compact-run">
      <h2 id="compact-run">{{ s.start_summary_heading }}</h2>
      <p><RenderText :node="s.start_summary_instructions()" /></p>
      <figure class="guide-figure">
        <CompactStep stage="run" :messages="s" />
        <figcaption class="caption"><RenderText :node="s.summary_progress_caption()" /></figcaption>
      </figure>
    </section>

    <section class="walkthrough-step" aria-labelledby="compact-result">
      <h2 id="compact-result">{{ s.review_shorter_path_heading }}</h2>
      <p>{{ s.review_shorter_path_instructions }}</p>
      <figure class="guide-figure">
        <CompactStep stage="result" :messages="s" />
        <figcaption class="caption">{{ s.shorter_path_caption }}</figcaption>
      </figure>
    </section>

    <RelatedGuide :locale="locale" :eyebrow="common.related_guides" :guides="[{ page: 'chat-branching', title: s.branch_and_edit_conversations, description: s.keep_original_path_while_branching }]" />
  </article>
</template>

<style scoped>
.prerequisite { padding:16px 19px;border-left:3px solid var(--blue);border-radius:0 10px 10px 0;background:var(--surface); }
.walkthrough-step { border-top:1px solid var(--line);margin-top:38px;padding-top:22px; }
.walkthrough-step h2 { margin-top:0; }
.walkthrough-step > p { margin-bottom:0; }
.walkthrough-step .guide-figure { margin:18px 0 0; }
</style>
