<script setup lang="ts">
import RenderText from '../../components/RenderText';
import UiLabel from '../../components/UiLabel.vue';
import ChatSearchGuideStep from '../../components/demos/ChatSearchGuideStep.vue';
import RelatedGuide from '../../components/RelatedGuide.vue';
import type { DocsLocale } from '../../navigation/routes';
import type { ChatSearchGuideMessages, CommonMessages } from '../../messages/types';

const { s } = defineProps<{ s: ChatSearchGuideMessages; locale: DocsLocale; common: CommonMessages }>();
defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <article class="prose" data-testid="docs-chat-search">
    <h1>{{ s.title }}</h1>
    <p class="lead">{{ s.introduction }}</p>
    <p class="app-entry-intro"><RenderText :node="s.open_naidan({ locale, destination: { kind: 'screen', screen: 'home' } })" /></p>

    <section aria-labelledby="search-global">
      <h2 id="search-global">{{ s.global_heading }}</h2>
      <p><RenderText :node="s.global_instructions()" /></p>
      <figure class="guide-figure">
        <ChatSearchGuideStep stage="find" :messages="s" :chrome="common" />
        <figcaption class="caption">{{ s.global_caption }}</figcaption>
      </figure>
      <p>{{ s.search_mode_introduction }}</p>
      <div class="table-scroll">
        <table data-testid="chat-search-modes">
          <thead><tr><th>{{ s.mode_column }}</th><th>{{ s.meaning_column }}</th></tr></thead>
          <tbody>
            <tr><th><UiLabel :text="s.all" /></th><td>{{ s.all_description }}</td></tr>
            <tr><th><UiLabel :text="s.current_thread" /></th><td>{{ s.current_thread_description }}</td></tr>
            <tr><th><UiLabel :text="s.title_only" /></th><td>{{ s.title_only_description }}</td></tr>
          </tbody>
        </table>
      </div>
      <p><RenderText :node="s.role_instructions()" /></p>
    </section>

    <section aria-labelledby="search-target">
      <h2 id="search-target">{{ s.target_heading }}</h2>
      <p>{{ s.target_introduction }}</p>
      <h3>{{ s.group_heading }}</h3>
      <p><RenderText :node="s.group_instructions()" /></p>
      <figure class="guide-figure">
        <ChatSearchGuideStep stage="group" :messages="s" :chrome="common" />
        <figcaption class="caption">{{ s.group_caption }}</figcaption>
      </figure>
      <h3>{{ s.chat_heading }}</h3>
      <p><RenderText :node="s.chat_instructions()" /></p>
      <figure class="guide-figure">
        <ChatSearchGuideStep stage="chat" :messages="s" :chrome="common" />
        <figcaption class="caption">{{ s.chat_caption }}</figcaption>
      </figure>
    </section>

    <section aria-labelledby="search-open">
      <h2 id="search-open">{{ s.open_heading }}</h2>
      <p><RenderText :node="s.open_instructions()" /></p>
      <figure class="guide-figure">
        <ChatSearchGuideStep stage="open" :messages="s" :chrome="common" />
        <figcaption class="caption">{{ s.open_caption }}</figcaption>
      </figure>
      <p>{{ s.keyboard_instructions }}</p>
    </section>

    <section aria-labelledby="search-return">
      <h2 id="search-return">{{ s.return_heading }}</h2>
      <p>{{ s.return_instructions }}</p>
      <p><RenderText :node="s.ai_instructions({ locale })" /></p>
    </section>

    <RelatedGuide :locale="locale" :eyebrow="common.related_guides" :guides="[
      { page: 'wesh-sysfs', title: s.related_sysfs_title, description: s.related_sysfs_description },
      { page: 'chat-branching', title: s.related_branching_title, description: s.related_branching_description },
    ]" />
  </article>
</template>

<style scoped>
section {
  margin-top: 38px;
  padding-top: 12px;
  border-top: 1px solid var(--line);
}
.table-scroll {
  max-width: 100%;
  overflow-x: auto;
}
table {
  width: 100%;
}
tbody th {
  width: 30%;
  font-weight: 500;
}
</style>
