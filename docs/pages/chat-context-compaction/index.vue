<script setup lang="ts">
import DocsLink from '../../site/DocsLink.vue';
import UiText from '../../site/UiText.vue';
import AppEntryLink from '../../site/AppEntryLink.vue';
import CompactStep from '../../site/demos/CompactStep.vue';
import RelatedGuide from '../../site/RelatedGuide.vue';
import type { DocsLocale } from '../../site/routes';
import type { CommonMessages } from '../../site/messages';
import type { strings as compactStrings } from '../../pages/chat-context-compaction/strings/en';

defineProps<{ s: typeof compactStrings; locale: DocsLocale; common: CommonMessages }>();

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <article class="prose" data-testid="docs-chat-compact">
    <h1>{{ s.title }}</h1>
    <p class="lead"><UiText :text="s.intro" /></p>
    <p class="app-entry-intro">{{ s.launch.before }}<AppEntryLink :destination="{ kind: 'screen', screen: 'home' }" :locale="locale" display="path" /><UiText :text="s.launch.after" /></p>
    <p class="prerequisite"><UiText :text="s.prerequisite" /> {{ s.setup.before }}<DocsLink :locale="locale" page="local-ai-servers">{{ s.setup.link }}</DocsLink>{{ s.setup.between }}<DocsLink :locale="locale" page="in-browser-models">{{ s.setup.browserLink }}</DocsLink>{{ s.setup.after }}</p>

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

    <RelatedGuide :locale="locale" :eyebrow="common.relatedGuides" :guides="[{ page: 'chat-branching', title: s.related, description: s.nextDescription }]" />
  </article>
</template>

<style scoped>
.prerequisite { padding:16px 19px;border-left:3px solid var(--blue);border-radius:0 10px 10px 0;background:var(--surface); }
.walkthrough-step { border-top:1px solid var(--line);margin-top:38px;padding-top:22px; }
.walkthrough-step h2 { margin-top:0; }
.walkthrough-step > p { margin-bottom:0; }
.walkthrough-step .guide-figure { margin:18px 0 0; }
</style>
