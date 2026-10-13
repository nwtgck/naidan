<script setup lang="ts">
import BrowserModelSettingsStep from '../../site/demos/BrowserModelSettingsStep.vue';
import { docsHref, type DocsLocale } from '../../site/routes';
import type { CommonMessages } from '../../site/messages';
import type { strings as english } from '../../strings/models/transformers-js/en';

defineProps<{ s: typeof english; locale: DocsLocale; common: CommonMessages }>();

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <article class="prose" data-testid="docs-models-transformers-js">
    <h1>{{ s.title }}</h1>
    <p class="lead">{{ s.intro }}</p>
    <p class="guide-context">{{ s.availability }}</p>

    <section class="walkthrough-step" aria-labelledby="transformers-guide-open">
      <h2 id="transformers-guide-open">{{ s.steps.open.title }}</h2>
      <p>{{ s.steps.open.body }}</p>
      <figure class="guide-figure">
        <BrowserModelSettingsStep mode="transformers" stage="open" :copy="s.demo" />
        <figcaption class="caption">{{ s.steps.open.caption }}</figcaption>
      </figure>
    </section>

    <section class="walkthrough-step" aria-labelledby="transformers-guide-download">
      <h2 id="transformers-guide-download">{{ s.steps.download.title }}</h2>
      <p>{{ s.steps.download.body }}</p>
      <figure class="guide-figure">
        <BrowserModelSettingsStep mode="transformers" stage="download" :copy="s.demo" />
        <figcaption class="caption">{{ s.steps.download.caption }}</figcaption>
      </figure>
    </section>

    <section class="walkthrough-step" aria-labelledby="transformers-guide-resume">
      <h2 id="transformers-guide-resume">{{ s.steps.resume.title }}</h2>
      <p>{{ s.steps.resume.body }}</p>
      <figure class="guide-figure">
        <BrowserModelSettingsStep mode="transformers" stage="resume" :copy="s.demo" />
        <figcaption class="caption">{{ s.steps.resume.caption }}</figcaption>
      </figure>
    </section>

    <section class="walkthrough-step" aria-labelledby="transformers-guide-save">
      <h2 id="transformers-guide-save">{{ s.steps.save.title }}</h2>
      <p>{{ s.steps.save.body }}</p>
      <figure class="guide-figure">
        <BrowserModelSettingsStep mode="transformers" stage="save" :copy="s.demo" />
        <figcaption class="caption">{{ s.steps.save.caption }}</figcaption>
      </figure>
    </section>

    <h2>{{ s.noteTitle }}</h2>
    <p>{{ s.note }}</p>
    <a class="next-link" :href="docsHref({ locale, page: 'models/in-browser' })">{{ s.next }} <span aria-hidden="true">→</span></a>
  </article>
</template>

<style scoped>
.guide-context { padding:17px 20px;border-left:3px solid var(--blue);background:var(--surface);border-radius:0 10px 10px 0; }
.walkthrough-step { border-top:1px solid var(--line);margin-top:38px;padding-top:22px; }
.walkthrough-step h2 { margin-top:0; }
.walkthrough-step > p { margin-bottom:0; }
.walkthrough-step .guide-figure { margin:18px 0 0; }
.walkthrough-step figcaption { margin-inline:auto;max-width:660px; }
</style>
