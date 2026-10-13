<script setup lang="ts">
import BrowserProvidedSettingsStep from '../../site/demos/BrowserProvidedSettingsStep.vue';
import { docsHref } from '../../site/routes';
import type { DocsLocale } from '../../site/routes';
import type { BrowserProvidedGuideMessages, CommonMessages } from '../../site/messages';

defineProps<{ s: BrowserProvidedGuideMessages; locale: DocsLocale; common: CommonMessages }>();

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <article class="prose" data-testid="docs-models-browser-provided">
    <h1>{{ s.title }}</h1>
    <p class="lead">{{ s.intro }}</p>
    <p class="before-step">{{ s.before }}</p>

    <section class="walkthrough-step" aria-labelledby="browser-open">
      <h2 id="browser-open">{{ s.steps.open.title }}</h2>
      <p>{{ s.steps.open.body }}</p>
      <figure class="guide-figure"><BrowserProvidedSettingsStep stage="open" :copy="s.demo" /><figcaption class="caption">{{ s.steps.open.caption }}</figcaption></figure>
    </section>

    <section class="walkthrough-step" aria-labelledby="browser-select">
      <h2 id="browser-select">{{ s.steps.select.title }}</h2>
      <p>{{ s.steps.select.body }}</p>
      <figure class="guide-figure"><BrowserProvidedSettingsStep stage="select" :copy="s.demo" /><figcaption class="caption">{{ s.steps.select.caption }}</figcaption></figure>
    </section>

    <section class="walkthrough-step" aria-labelledby="browser-prepare">
      <h2 id="browser-prepare">{{ s.steps.prepare.title }}</h2>
      <p>{{ s.steps.prepare.body }}</p>
      <figure class="guide-figure"><BrowserProvidedSettingsStep stage="prepare" :copy="s.demo" /><figcaption class="caption">{{ s.steps.prepare.caption }}</figcaption></figure>
    </section>

    <section class="walkthrough-step" aria-labelledby="browser-save">
      <h2 id="browser-save">{{ s.steps.save.title }}</h2>
      <p>{{ s.steps.save.body }}</p>
      <figure class="guide-figure"><BrowserProvidedSettingsStep stage="save" :copy="s.demo" /><figcaption class="caption">{{ s.steps.save.caption }}</figcaption></figure>
    </section>

    <h2>{{ s.unavailableTitle }}</h2>
    <p>{{ s.unavailable }}</p>
    <a class="next-link" :href="docsHref({ locale, page: 'models/in-browser' })">{{ s.next }} <span aria-hidden="true">→</span></a>
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
