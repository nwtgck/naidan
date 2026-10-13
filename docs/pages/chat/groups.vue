<script setup lang="ts">
import UiText from '../../site/UiText.vue';
import GroupStep from '../../site/demos/GroupStep.vue';
import { docsHref } from '../../site/routes';
import type { DocsLocale } from '../../site/routes';
import type { CommonMessages } from '../../site/messages';
import type { strings as groupsStrings } from '../../strings/chat/groups/en';

defineProps<{ s: typeof groupsStrings; locale: DocsLocale; common: CommonMessages }>();

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <article class="prose" data-testid="docs-chat-groups">
    <h1>{{ s.title }}</h1>
    <p class="lead"><UiText :text="s.intro" /></p>

    <section class="walkthrough-step" aria-labelledby="groups-create">
      <h2 id="groups-create">{{ s.steps.create.title }}</h2>
      <p><UiText :text="s.steps.create.body" /></p>
      <figure class="guide-figure">
        <GroupStep stage="create" :copy="s.demo" />
        <figcaption class="caption"><UiText :text="s.steps.create.caption" /></figcaption>
      </figure>
    </section>

    <section class="walkthrough-step" aria-labelledby="groups-move">
      <h2 id="groups-move">{{ s.steps.move.title }}</h2>
      <p><UiText :text="s.steps.move.body" /></p>
      <figure class="guide-figure">
        <GroupStep stage="move" :copy="s.demo" />
        <figcaption class="caption"><UiText :text="s.steps.move.caption" /></figcaption>
      </figure>
    </section>

    <section class="walkthrough-step" aria-labelledby="groups-add">
      <h2 id="groups-add">{{ s.steps.add.title }}</h2>
      <p><UiText :text="s.steps.add.body" /></p>
      <figure class="guide-figure">
        <GroupStep stage="add" :copy="s.demo" />
        <figcaption class="caption"><UiText :text="s.steps.add.caption" /></figcaption>
      </figure>
    </section>

    <section class="walkthrough-step" aria-labelledby="groups-tidy">
      <h2 id="groups-tidy">{{ s.steps.tidy.title }}</h2>
      <p><UiText :text="s.steps.tidy.body" /></p>
      <figure class="guide-figure">
        <GroupStep stage="tidy" :copy="s.demo" />
        <figcaption class="caption"><UiText :text="s.steps.tidy.caption" /></figcaption>
      </figure>
    </section>

    <a class="next-link" :href="docsHref({ locale, page: 'settings/inheritance' })">{{ s.related }} <span aria-hidden="true">→</span></a>
  </article>
</template>

<style scoped>
.walkthrough-step { border-top:1px solid var(--line);margin-top:38px;padding-top:22px; }
.walkthrough-step h2 { margin-top:0; }
.walkthrough-step > p { margin-bottom:0; }
.walkthrough-step .guide-figure { margin:18px 0 0; }
</style>
