<script setup lang="ts">
import UiText from '../../site/UiText.vue';
import AppEntryLink from '../../site/AppEntryLink.vue';
import ExternalLink from '../../site/ExternalLink.vue';
import RelatedGuide from '../../site/RelatedGuide.vue';
import NaidanRpcStep from '../../site/demos/NaidanRpcStep.vue';
import type { CommonMessages, NaidanRpcMessages } from '../../site/messages';
import type { DocsLocale } from '../../site/routes';

defineProps<{ s: NaidanRpcMessages; locale: DocsLocale; common: CommonMessages }>();

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <article class="prose" data-testid="docs-models-naidan-rpc">
    <h1>{{ s.title }}</h1>
    <p class="lead"><UiText :text="s.intro" /></p>
    <p class="app-entry-intro">{{ s.launch.before }}<AppEntryLink :destination="{ kind: 'screen', screen: 'home' }" :locale="locale" display="path" />{{ s.launch.after }}</p>
    <p class="hosted-example"><UiText :text="s.hostedExample.body" /> <ExternalLink href="https://naidan.pages.dev/" :locale="locale">{{ s.hostedExample.link }}</ExternalLink></p>

    <section v-for="(step, key) in s.steps" :key="key" class="rpc-step" :aria-labelledby="`rpc-${key}`" data-testid="rpc-guide-step">
      <h2 :id="`rpc-${key}`">{{ step.title }}</h2>
      <p><UiText :text="step.body" /></p>
      <p v-if="key === 'pair'" class="relay-origin"><UiText :text="s.relayIntro" /> <code>{{ s.demo.serverSample }}</code> <ExternalLink href="https://github.com/nwtgck/piping-server#public-servers" :locale="locale">{{ s.relaySource }}</ExternalLink></p>
      <figure class="guide-figure"><NaidanRpcStep :stage="key" :copy="s.demo" /><figcaption class="caption"><UiText :text="step.caption" /></figcaption></figure>
    </section>

    <section class="rpc-note"><h2>{{ s.imageTitle }}</h2><p><UiText :text="s.image" /></p></section>
    <section class="rpc-note"><h2>{{ s.boundaryTitle }}</h2><p><UiText :text="s.boundary" /></p></section>
    <section class="rpc-note"><h2>{{ s.availabilityTitle }}</h2><p><UiText :text="s.availability" /></p></section>

    <RelatedGuide :locale="locale" :eyebrow="common.relatedGuides" :guides="[{ page: 'endpoint-type-llama-cpp-browser', title: s.relatedTitle, description: s.relatedDescription }]" />
  </article>
</template>

<style scoped>
.rpc-step { border-top:1px solid var(--line);margin-top:36px;padding-top:22px; }
.rpc-step h2 { margin-top:0; }
.rpc-step > p { margin-bottom:0; }
.rpc-step .guide-figure { margin:18px 0 0; }
.rpc-step figcaption { margin-inline:auto;max-width:680px; }
.rpc-note { margin-top:40px; }
</style>
