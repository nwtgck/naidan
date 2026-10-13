<script setup lang="ts">
import ExternalLink from '../../site/ExternalLink.vue';
import StandaloneDemo from '../../site/demos/StandaloneDemo.vue';
import { docsHref } from '../../site/routes';
import type { DocsLocale } from '../../site/routes';
import type { StandaloneMessages, CommonMessages } from '../../site/messages';
defineProps<{ s: StandaloneMessages; locale: DocsLocale; common: CommonMessages }>();


defineExpose({
  ...((__BUILD_MODE_IS_TEST__ && {
    TEST_ONLY: {
      // Export internal state and logic used only for testing here. Do not reference these in production logic.
      // ESLint-required for defineExpose.
    },
  }) || {}),
});
</script>
<template>
  <article class="prose" data-testid="docs-standalone">
    <h1>{{ s.title }}</h1>
    <p v-for="paragraph in s.intro" :key="paragraph" class="lead">{{ paragraph }}</p>
    <figure class="guide-figure"><StandaloneDemo :copy="s.demo" /><figcaption class="caption">{{ s.diagramCaption }}</figcaption></figure>
    <ExternalLink class="download-link" href="https://naidan.pages.dev/naidan-standalone.zip" :locale="locale">{{ s.download }}</ExternalLink>
    <h2>{{ s.stepsTitle }}</h2>
    <ol class="guide-steps"><li v-for="step in s.steps" :key="step.title"><h3>{{ step.title }}</h3><p>{{ step.body }}</p></li></ol>
    <h2>{{ s.modesTitle }}</h2>
    <div class="pair-grid"><section v-for="mode in s.modes" :key="mode.title" class="panel"><h3>{{ mode.title }}</h3><p>{{ mode.body }}</p></section></div>
    <section v-for="detail in s.details" :key="detail.title"><h2>{{ detail.title }}</h2><p>{{ detail.body }}</p></section>
    <a class="next-link" :href="docsHref({ locale, page: 'work/boundary' })">{{ s.next }} <span aria-hidden="true">→</span></a>
  </article>
</template>
