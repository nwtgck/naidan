<script setup lang="ts">
import UiText from '../../site/UiText.vue';
import AppEntryLink from '../../site/AppEntryLink.vue';
import ConnectionSettingsStep from '../../site/demos/ConnectionSettingsStep.vue';
import RelatedGuide from '../../site/RelatedGuide.vue';
import type { DocsLocale } from '../../site/routes';
import type { CommonMessages, OllamaGuideMessages } from '../../site/messages';

defineProps<{ s: OllamaGuideMessages; locale: DocsLocale; common: CommonMessages }>();

defineExpose({
  ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}),
});
</script>

<template>
  <article class="prose" data-testid="docs-models-ollama">
    <h1>{{ s.title }}</h1>
    <p class="lead"><UiText :text="s.intro" /></p>
    <p class="app-entry-intro">{{ s.launch.before }}<AppEntryLink :destination="{ kind: 'screen', screen: 'home' }" :locale="locale" display="path" />{{ s.launch.after }}</p>
    <p class="before-step"><UiText :text="s.before" /></p>

    <section class="walkthrough-step" aria-labelledby="ollama-open">
      <h2 id="ollama-open">{{ s.steps.open.title }}</h2>
      <p><UiText :text="s.steps.open.body" /></p>
      <figure class="guide-figure">
        <ConnectionSettingsStep stage="open" :copy="s.demo" />
        <figcaption class="caption"><UiText :text="s.steps.open.caption" /></figcaption>
      </figure>
    </section>

    <section class="walkthrough-step" aria-labelledby="ollama-provider">
      <h2 id="ollama-provider">{{ s.steps.provider.title }}</h2>
      <p><UiText :text="s.steps.provider.body" /></p>
      <figure class="guide-figure">
        <ConnectionSettingsStep stage="provider" :copy="s.demo" />
        <figcaption class="caption"><UiText :text="s.steps.provider.caption" /></figcaption>
      </figure>
    </section>

    <section class="walkthrough-step" aria-labelledby="ollama-check">
      <h2 id="ollama-check">{{ s.steps.check.title }}</h2>
      <p><UiText :text="s.steps.check.body" /></p>
      <figure class="guide-figure">
        <ConnectionSettingsStep stage="check" :copy="s.demo" />
        <figcaption class="caption"><UiText :text="s.steps.check.caption" /></figcaption>
      </figure>
    </section>

    <section class="walkthrough-step" aria-labelledby="ollama-model">
      <h2 id="ollama-model">{{ s.steps.model.title }}</h2>
      <p><UiText :text="s.steps.model.body" /></p>
      <figure class="guide-figure">
        <ConnectionSettingsStep stage="model" :copy="s.demo" />
        <figcaption class="caption"><UiText :text="s.steps.model.caption" /></figcaption>
      </figure>
    </section>

    <h2>{{ s.troubleTitle }}</h2>
    <p><UiText :text="s.trouble" /></p>
    <RelatedGuide :locale="locale" :eyebrow="common.relatedGuides" :guides="[{ page: 'local-ai-servers', title: s.next, description: s.nextDescription }]" />
  </article>
</template>

<style scoped>
.before-step { padding:17px 20px;border-left:3px solid var(--blue);background:var(--surface);border-radius:0 10px 10px 0; }
.walkthrough-step { border-top:1px solid var(--line);margin-top:38px;padding-top:22px; }
.walkthrough-step h2 { margin-top:0; }
.walkthrough-step > p { margin-bottom:0; }
.walkthrough-step .guide-figure { margin:18px 0 0; }
.walkthrough-step figcaption { margin-inline:auto;max-width:660px; }
</style>
