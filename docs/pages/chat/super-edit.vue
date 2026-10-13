<script setup lang="ts">
import SuperEditStep from '../../site/demos/SuperEditStep.vue';
import AppEntryLink from '../../site/AppEntryLink.vue';
import RelatedGuide from '../../site/RelatedGuide.vue';
import UiText from '../../site/UiText.vue';
import type { CommonMessages, SuperEditMessages } from '../../site/messages';
import type { DocsLocale } from '../../site/routes';

defineProps<{ s: SuperEditMessages; locale: DocsLocale; common: CommonMessages }>();
defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <article class="prose" data-testid="docs-chat-super-edit">
    <h1>{{ s.title }}</h1>
    <p class="lead"><UiText :text="s.intro" /></p>
    <p class="app-entry-intro">{{ s.launch.before }}<AppEntryLink :destination="{ kind: 'screen', screen: 'home' }" :locale="locale" display="path" /><UiText :text="s.launch.after" /></p>

    <section class="walkthrough-step" aria-labelledby="super-edit-open">
      <h2 id="super-edit-open">{{ s.steps.open.title }}</h2>
      <p><UiText :text="s.steps.open.body" /></p>
      <figure class="guide-figure"><SuperEditStep stage="open" :copy="s.demo" /><figcaption class="caption"><UiText :text="s.steps.open.caption" /></figcaption></figure>
    </section>

    <section class="walkthrough-step" aria-labelledby="super-edit-edit">
      <h2 id="super-edit-edit">{{ s.steps.edit.title }}</h2>
      <p><UiText :text="s.steps.edit.body" /></p>
      <figure class="guide-figure"><SuperEditStep stage="edit" :copy="s.demo" /><figcaption class="caption"><UiText :text="s.steps.edit.caption" /></figcaption></figure>
    </section>

    <section class="walkthrough-step" aria-labelledby="super-edit-prompt">
      <h2 id="super-edit-prompt">{{ s.steps.prompt.title }}</h2>
      <p><UiText :text="s.steps.prompt.body" /></p>
      <figure class="guide-figure"><SuperEditStep stage="prompt" :copy="s.demo" /><figcaption class="caption"><UiText :text="s.steps.prompt.caption" /></figcaption></figure>
    </section>

    <section class="walkthrough-step" aria-labelledby="super-edit-apply">
      <h2 id="super-edit-apply">{{ s.steps.apply.title }}</h2>
      <p><UiText :text="s.steps.apply.body" /></p>
      <figure class="guide-figure"><SuperEditStep stage="apply" :copy="s.demo" /><figcaption class="caption"><UiText :text="s.steps.apply.caption" /></figcaption></figure>
    </section>

    <h2>{{ s.detail.title }}</h2>
    <p>{{ s.detail.body }}</p>
    <RelatedGuide :locale="locale" :eyebrow="common.relatedGuides" :guides="[{ page: 'chat/branching', title: s.relatedTitle, description: s.relatedDescription }]" />
  </article>
</template>

<style scoped>
.walkthrough-step { border-top:1px solid var(--line);margin-top:38px;padding-top:22px; }
.walkthrough-step h2 { margin-top:0; }
.walkthrough-step > p { margin-bottom:0; }
.walkthrough-step .guide-figure { margin:18px 0 0; }
</style>
