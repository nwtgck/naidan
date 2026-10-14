<script setup lang="ts">
import AppEntryLink from '../../site/AppEntryLink.vue';
import OfflineGuideStep from '../../site/demos/OfflineGuideStep.vue';
import RelatedGuide from '../../site/RelatedGuide.vue';
import UiText from '../../site/UiText.vue';
import { docsHref } from '../../site/routes';
import type { DocsLocale } from '../../site/routes';
import type { CommonMessages, OfflineGuideMessages } from '../../site/messages';

defineProps<{ s: OfflineGuideMessages; locale: DocsLocale; common: CommonMessages }>();

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <article class="prose" data-testid="docs-run-offline">
    <h1>{{ s.title }}</h1>
    <p class="lead">{{ s.intro }}</p>
    <p class="app-entry-intro">{{ s.launch.before }}<AppEntryLink :destination="{ kind: 'screen', screen: 'home' }" :locale="locale" display="path" />{{ s.launch.after }}</p>

    <section class="walkthrough-step" aria-labelledby="offline-prepare">
      <h2 id="offline-prepare">{{ s.prepare.title }}</h2>
      <p>{{ s.prepare.body }}</p>
      <figure class="guide-figure">
        <OfflineGuideStep stage="prepare" :copy="s.demo" />
        <figcaption class="caption"><UiText :text="s.prepare.caption" /></figcaption>
      </figure>
      <p class="check-detail"><UiText :text="s.prepare.detail" /></p>
    </section>

    <section class="walkthrough-step" aria-labelledby="offline-model">
      <h2 id="offline-model">{{ s.model.title }}</h2>
      <p>{{ s.model.body }}</p>
      <p>{{ s.model.guideBefore }}<a :href="docsHref({ locale, page: 'models/llama-cpp-browser' })">{{ s.model.guideLabel }}</a>{{ s.model.guideAfter }}</p>
      <figure class="guide-figure">
        <OfflineGuideStep stage="model" :copy="s.demo" />
        <figcaption class="caption">{{ s.model.caption }}</figcaption>
      </figure>
    </section>

    <section class="walkthrough-step" aria-labelledby="offline-verify">
      <h2 id="offline-verify">{{ s.verify.title }}</h2>
      <p>{{ s.verify.body }}</p>
      <figure class="guide-figure">
        <OfflineGuideStep stage="verify" :copy="s.demo" />
        <figcaption class="caption">{{ s.verify.caption }}</figcaption>
      </figure>
      <p class="check-detail">{{ s.verify.limitation }}</p>
    </section>

    <section class="walkthrough-step" aria-labelledby="offline-update">
      <h2 id="offline-update">{{ s.update.title }}</h2>
      <p><UiText :text="s.update.body" /></p>
      <figure class="guide-figure">
        <OfflineGuideStep stage="update" :copy="s.demo" />
        <figcaption class="caption"><UiText :text="s.update.caption" /></figcaption>
      </figure>
      <p class="check-detail"><UiText :text="s.update.early" /></p>
    </section>

    <section class="scope-section" aria-labelledby="offline-scope">
      <h2 id="offline-scope">{{ s.scope.title }}</h2>
      <p>{{ s.scope.body }}</p>
      <p>{{ s.scope.alternatives }}</p>
    </section>

    <RelatedGuide :locale="locale" :eyebrow="common.relatedGuides" :guides="[
      { page: 'models/llama-cpp-browser', title: s.related.gguf, description: s.related.ggufDescription },
      { page: 'models/in-browser', title: s.related.models, description: s.related.modelsDescription },
      { page: 'run/standalone', title: s.related.standalone, description: s.related.standaloneDescription },
      { page: 'run/hosted', title: s.related.hostedZip, description: s.related.hostedZipDescription },
    ]" />
  </article>
</template>

<style scoped>
.walkthrough-step { border-top:1px solid var(--line);margin-top:35px;padding-top:24px; }
.walkthrough-step h2 { margin-top:0; }
.walkthrough-step .guide-figure { margin:21px 0 0; }
.walkthrough-step figcaption { max-width:680px; }
.check-detail { margin:17px 0 0;padding:15px 18px;border-left:3px solid var(--blue);border-radius:0 10px 10px 0;background:var(--surface); }
.scope-section { margin-top:43px; }
</style>
