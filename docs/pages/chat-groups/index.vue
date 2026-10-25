<script setup lang="ts">
import RenderText from '../../components/RenderText';
import ChatGroupStep from '../../components/demos/ChatGroupStep.vue';
import ChatGroupSettingsStep from '../../components/demos/ChatGroupSettingsStep.vue';
import RelatedGuide from '../../components/RelatedGuide.vue';
import type { DocsLocale } from '../../navigation/routes';
import type { CommonMessages } from '../../messages/types';
import type { messages as groupsMessages } from './messages/en';

const { s } = defineProps<{ s: typeof groupsMessages; locale: DocsLocale; common: CommonMessages }>();

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <article class="prose" data-testid="docs-chat-groups">
    <h1>{{ s.title }}</h1>
    <p class="lead">{{ s.organize_chats_by_purpose }}</p>
    <p class="app-entry-intro"><RenderText :node="s.open_naidan_to_create_group({ locale, destination: { kind: 'screen', screen: 'home' } })" /></p>

    <section class="walkthrough-step" aria-labelledby="groups-create">
      <h2 id="groups-create">{{ s.create_group_heading }}</h2>
      <p><RenderText :node="s.create_group_instructions()" /></p>
      <figure class="guide-figure">
        <ChatGroupStep stage="create" :messages="s" :chrome="common" />
        <figcaption class="caption">{{ s.group_creation_caption }}</figcaption>
      </figure>
    </section>

    <p class="prerequisite"><RenderText :node="s.model_setup_guides({ locale })" /></p>

    <section class="walkthrough-step" aria-labelledby="groups-model">
      <h2 id="groups-model">{{ s.choose_group_model_heading }}</h2>
      <p><RenderText :node="s.choose_group_model_instructions()" /></p>
      <figure class="guide-figure">
        <ChatGroupSettingsStep stage="model" :messages="s" />
        <figcaption class="caption"><RenderText :node="s.group_model_caption()" /></figcaption>
      </figure>
    </section>

    <section class="walkthrough-step" aria-labelledby="groups-prompt">
      <h2 id="groups-prompt">{{ s.set_group_instructions_heading }}</h2>
      <p><RenderText :node="s.set_group_instructions()" /></p>
      <figure class="guide-figure">
        <ChatGroupSettingsStep stage="prompt" :messages="s" />
        <figcaption class="caption">{{ s.group_instructions_caption }}</figcaption>
      </figure>
    </section>

    <section class="walkthrough-step" aria-labelledby="groups-move">
      <h2 id="groups-move">{{ s.move_chat_into_group_heading }}</h2>
      <p><RenderText :node="s.move_chat_into_group_instructions()" /></p>
      <figure class="guide-figure">
        <ChatGroupStep stage="move" :messages="s" :chrome="common" />
        <figcaption class="caption"><RenderText :node="s.move_chat_caption()" /></figcaption>
      </figure>
    </section>

    <section class="walkthrough-step" aria-labelledby="groups-add">
      <h2 id="groups-add">{{ s.start_chat_inside_group_heading }}</h2>
      <p><RenderText :node="s.start_chat_inside_group_instructions()" /></p>
      <figure class="guide-figure">
        <ChatGroupStep stage="add" :messages="s" :chrome="common" />
        <figcaption class="caption"><RenderText :node="s.add_chat_caption()" /></figcaption>
      </figure>
    </section>

    <section class="walkthrough-step" aria-labelledby="groups-tidy">
      <h2 id="groups-tidy">{{ s.organize_sidebar_heading }}</h2>
      <p><RenderText :node="s.organize_sidebar_instructions()" /></p>
      <figure class="guide-figure">
        <ChatGroupStep stage="tidy" :messages="s" :chrome="common" />
        <figcaption class="caption">{{ s.organized_sidebar_caption }}</figcaption>
      </figure>
    </section>

    <RelatedGuide :locale="locale" :eyebrow="common.related_guides" :guides="[{ page: 'settings-inheritance', title: s.choose_models_per_chat, description: s.understand_model_inheritance }]" />
  </article>
</template>

<style scoped>
.prerequisite {
  margin: 36px 0 0;
  padding: 16px 19px;
  border-left: 3px solid var(--blue);
  border-radius: 0 10px 10px 0;
  background: var(--surface);
}
.walkthrough-step {
  border-top: 1px solid var(--line);
  margin-top: 38px;
  padding-top: 22px;
}
.prerequisite + .walkthrough-step {
  margin-top: 18px;
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
