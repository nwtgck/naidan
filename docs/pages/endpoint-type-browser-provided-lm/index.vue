<script setup lang="ts">
import UiText from '../../site/UiText.vue';
import ExternalLink from '../../site/ExternalLink.vue';
import AppEntryLink from '../../site/AppEntryLink.vue';
import ChromeModelFlow from '../../site/demos/ChromeModelFlow.vue';
import BrowserProvidedSettingsStep from '../../site/demos/BrowserProvidedSettingsStep.vue';
import RelatedGuide from '../../site/RelatedGuide.vue';
import DocsIsland from '../../site/DocsIsland.vue';
import { browserAiAvailabilityIsland } from '../../islands/browser-ai-availability/definition';
import { checkerCopy } from '../../islands/browser-ai-availability/copy';
import type { DocsLocale } from '../../site/routes';
import type { BrowserProvidedGuideMessages, CommonMessages } from '../../site/messages';

defineProps<{ s: BrowserProvidedGuideMessages; locale: DocsLocale; common: CommonMessages }>();

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <article class="prose" data-testid="docs-models-browser-provided">
    <h1>{{ s.title }}</h1>
    <p class="lead"><UiText :text="s.intro" /></p>
    <section class="concept-section" aria-labelledby="browser-model-flow">
      <h2 id="browser-model-flow">{{ s.flow.title }}</h2>
      <figure class="guide-figure"><ChromeModelFlow :copy="s.flow.demo" /><figcaption class="caption"><UiText :text="s.flow.caption" /></figcaption></figure>
    </section>

    <DocsIsland :entry="browserAiAvailabilityIsland({ copy: checkerCopy[locale] })" />

    <details class="requirements-details">
      <summary>{{ s.requirementsSummary }}</summary>
      <p><UiText :text="s.before" /></p>
      <p><UiText :text="s.languageSupport" /></p>
      <p class="requirements-source"><ExternalLink href="https://developer.chrome.com/docs/ai/prompt-api" :locale="locale">{{ s.requirementsSource }}</ExternalLink> · <ExternalLink href="https://developer.chrome.com/docs/ai/get-started" :locale="locale">{{ s.languageSource }}</ExternalLink></p>
    </details>

    <p class="app-entry-intro">{{ s.launch.before }}<AppEntryLink :destination="{ kind: 'screen', screen: 'connection' }" :locale="locale" display="path" />{{ s.launch.after }}</p>
    <p class="app-entry-onboarding"><UiText :text="s.onboarding" /></p>

    <section class="walkthrough-step" aria-labelledby="browser-open">
      <h2 id="browser-open">{{ s.steps.open.title }}</h2>
      <p><UiText :text="s.steps.open.body" /></p>
      <figure class="guide-figure"><BrowserProvidedSettingsStep stage="open" :copy="s.demo" /><figcaption class="caption"><UiText :text="s.steps.open.caption" /></figcaption></figure>
    </section>

    <section class="walkthrough-step" aria-labelledby="browser-select">
      <h2 id="browser-select">{{ s.steps.select.title }}</h2>
      <p><UiText :text="s.steps.select.body" /></p>
      <figure class="guide-figure"><BrowserProvidedSettingsStep stage="select" :copy="s.demo" /><figcaption class="caption"><UiText :text="s.steps.select.caption" /></figcaption></figure>
    </section>

    <section class="walkthrough-step" aria-labelledby="browser-prepare">
      <h2 id="browser-prepare">{{ s.steps.prepare.title }}</h2>
      <p><UiText :text="s.steps.prepare.body" /></p>
      <figure class="guide-figure"><BrowserProvidedSettingsStep stage="prepare" :copy="s.demo" /><figcaption class="caption"><UiText :text="s.steps.prepare.caption" /></figcaption></figure>
    </section>

    <section class="walkthrough-step" aria-labelledby="browser-save">
      <h2 id="browser-save">{{ s.steps.save.title }}</h2>
      <p><UiText :text="s.steps.save.body" /></p>
      <figure class="guide-figure"><BrowserProvidedSettingsStep stage="save" :copy="s.demo" /><figcaption class="caption"><UiText :text="s.steps.save.caption" /></figcaption></figure>
    </section>

    <p><UiText :text="s.startChat" /></p>

    <h2>{{ s.unavailableTitle }}</h2>
    <p><UiText :text="s.unavailable" /></p>
    <RelatedGuide :locale="locale" :eyebrow="common.relatedGuides" :guides="[{ page: 'in-browser-models', title: s.next, description: s.nextDescription }]" />
  </article>
</template>

<style scoped>
.concept-section h2{margin-bottom:0}
.concept-section .guide-figure{margin:18px 0 28px}
.concept-section figcaption{margin-inline:auto;max-width:660px}
.requirements-details{margin:30px 0 28px;padding:0 20px;border:1px solid var(--line-strong);border-radius:12px;background:var(--surface)}
.requirements-details summary{padding:17px 0;color:var(--text);font-weight:750;cursor:pointer}
.requirements-details summary:focus-visible{outline:2px solid var(--blue);outline-offset:3px}
.requirements-details[open] summary{border-bottom:1px solid var(--line)}
.requirements-details p{margin:16px 0 0}
.requirements-details .requirements-source{margin:10px 0 17px;font-size:.9em}
.walkthrough-step{border-top:1px solid var(--line);margin-top:38px;padding-top:22px}
.walkthrough-step h2{margin-top:0}
.walkthrough-step>p{margin-bottom:0}
.walkthrough-step .guide-figure{margin:18px 0 0}
.walkthrough-step figcaption{margin-inline:auto;max-width:660px}
</style>
