<script setup lang="ts">
import UiText from '../../site/UiText.vue';
import CompactStep from '../../site/demos/CompactStep.vue';
import { docsHref } from '../../site/routes';
import type { DocsLocale } from '../../site/routes';
import type { CommonMessages } from '../../site/messages';
import type { strings as compactStrings } from '../../strings/chat/compact/en';

defineProps<{ s: typeof compactStrings; locale: DocsLocale; common: CommonMessages }>();

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <article class="prose" data-testid="docs-chat-compact">
    <h1>{{ s.title }}</h1>
    <p class="lead"><UiText :text="s.intro" /></p>
    <p class="prerequisite"><UiText :text="s.prerequisite" /></p>

    <section class="walkthrough-step" aria-labelledby="compact-open">
      <h2 id="compact-open">{{ s.steps.open.title }}</h2>
      <p><UiText :text="s.steps.open.body" /></p>
      <figure class="guide-figure">
        <CompactStep stage="open" :copy="s.demo" />
        <figcaption class="caption"><UiText :text="s.steps.open.caption" /></figcaption>
      </figure>
    </section>

    <section class="walkthrough-step" aria-labelledby="compact-keep">
      <h2 id="compact-keep">{{ s.steps.keep.title }}</h2>
      <p><UiText :text="s.steps.keep.body" /></p>
      <figure class="guide-figure">
        <CompactStep stage="keep" :copy="s.demo" />
        <figcaption class="caption"><UiText :text="s.steps.keep.caption" /></figcaption>
      </figure>
    </section>

    <section class="walkthrough-step" aria-labelledby="compact-run">
      <h2 id="compact-run">{{ s.steps.run.title }}</h2>
      <p><UiText :text="s.steps.run.body" /></p>
      <figure class="guide-figure">
        <CompactStep stage="run" :copy="s.demo" />
        <figcaption class="caption"><UiText :text="s.steps.run.caption" /></figcaption>
      </figure>
    </section>

    <section class="walkthrough-step" aria-labelledby="compact-result">
      <h2 id="compact-result">{{ s.steps.result.title }}</h2>
      <p><UiText :text="s.steps.result.body" /></p>
      <figure class="guide-figure">
        <CompactStep stage="result" :copy="s.demo" />
        <figcaption class="caption"><UiText :text="s.steps.result.caption" /></figcaption>
      </figure>
    </section>

    <a class="next-link" :href="docsHref({ locale, page: 'chat/branching' })">{{ s.related }} <span aria-hidden="true">→</span></a>
  </article>
</template>

<style scoped>
.prerequisite { padding:16px 19px;border-left:3px solid var(--blue);border-radius:0 10px 10px 0;background:var(--surface); }
.walkthrough-step { border-top:1px solid var(--line);margin-top:38px;padding-top:22px; }
.walkthrough-step h2 { margin-top:0; }
.walkthrough-step > p { margin-bottom:0; }
.walkthrough-step .guide-figure { margin:18px 0 0; }
</style>
