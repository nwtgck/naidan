<script setup lang="ts">
import UiText from '../../site/UiText.vue';
import AppEntryLink from '../../site/AppEntryLink.vue';
import OpenAiCompatibleSettingsStep from '../../site/demos/OpenAiCompatibleSettingsStep.vue';
import RelatedGuide from '../../site/RelatedGuide.vue';
import type { DocsLocale } from '../../site/routes';
import type { CommonMessages, OpenAiCompatibleGuideMessages } from '../../site/messages';

defineProps<{ s: OpenAiCompatibleGuideMessages; locale: DocsLocale; common: CommonMessages }>();

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <article class="prose" data-testid="docs-models-openai-compatible">
    <h1>{{ s.title }}</h1>
    <p class="lead"><UiText :text="s.intro" /></p>
    <p class="app-entry-intro">{{ s.launch.before }}<AppEntryLink :destination="{ kind: 'screen', screen: 'home' }" :locale="locale" display="path" />{{ s.launch.after }}</p>
    <p class="before-step"><UiText :text="s.before" /></p>

    <section class="walkthrough-step" aria-labelledby="openai-open">
      <h2 id="openai-open">{{ s.steps.open.title }}</h2>
      <p><UiText :text="s.steps.open.body" /></p>
      <figure class="guide-figure"><OpenAiCompatibleSettingsStep stage="open" :copy="s.demo" /><figcaption class="caption"><UiText :text="s.steps.open.caption" /></figcaption></figure>
    </section>

    <section class="walkthrough-step" aria-labelledby="openai-provider">
      <h2 id="openai-provider">{{ s.steps.provider.title }}</h2>
      <p><UiText :text="s.steps.provider.body" /></p>
      <figure class="guide-figure"><OpenAiCompatibleSettingsStep stage="provider" :copy="s.demo" /><figcaption class="caption"><UiText :text="s.steps.provider.caption" /></figcaption></figure>
    </section>

    <section class="walkthrough-step" aria-labelledby="openai-headers">
      <h2 id="openai-headers">{{ s.steps.headers.title }}</h2>
      <p><UiText :text="s.steps.headers.body" /></p>
      <figure class="guide-figure"><OpenAiCompatibleSettingsStep stage="headers" :copy="s.demo" /><figcaption class="caption"><UiText :text="s.steps.headers.caption" /></figcaption></figure>
    </section>

    <section class="walkthrough-step" aria-labelledby="openai-check">
      <h2 id="openai-check">{{ s.steps.check.title }}</h2>
      <p><UiText :text="s.steps.check.body" /></p>
      <figure class="guide-figure"><OpenAiCompatibleSettingsStep stage="check" :copy="s.demo" /><figcaption class="caption"><UiText :text="s.steps.check.caption" /></figcaption></figure>
    </section>

    <section class="walkthrough-step" aria-labelledby="openai-model">
      <h2 id="openai-model">{{ s.steps.model.title }}</h2>
      <p><UiText :text="s.steps.model.body" /></p>
      <figure class="guide-figure"><OpenAiCompatibleSettingsStep stage="model" :copy="s.demo" /><figcaption class="caption"><UiText :text="s.steps.model.caption" /></figcaption></figure>
    </section>

    <h2>{{ s.troubleTitle }}</h2>
    <p><UiText :text="s.trouble" /></p>
    <RelatedGuide :locale="locale" :eyebrow="common.relatedGuides" :guides="[{ page: 'models/local-engines', title: s.next, description: s.nextDescription }]" />
  </article>
</template>

<style scoped>
.before-step{padding:17px 20px;border-left:3px solid var(--blue);background:var(--surface);border-radius:0 10px 10px 0}
.walkthrough-step{border-top:1px solid var(--line);margin-top:38px;padding-top:22px}
.walkthrough-step h2{margin-top:0}
.walkthrough-step>p{margin-bottom:0}
.walkthrough-step .guide-figure{margin:18px 0 0}
.walkthrough-step figcaption{margin-inline:auto;max-width:660px}
</style>
