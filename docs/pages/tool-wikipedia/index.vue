<script setup lang="ts">
import DocsLink from '../../site/DocsLink.vue';
import AppEntryLink from '../../site/AppEntryLink.vue';
import RelatedGuide from '../../site/RelatedGuide.vue';
import UiText from '../../site/UiText.vue';
import WikipediaChatStep from '../../site/demos/WikipediaChatStep.vue';
import WikipediaSettingsStep from '../../site/demos/WikipediaSettingsStep.vue';
import type { DocsLocale } from '../../site/routes';
import type { CommonMessages, WikipediaMessages } from '../../site/messages';

defineProps<{ s: WikipediaMessages; locale: DocsLocale; common: CommonMessages }>();
defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <article class="prose" data-testid="docs-wikipedia">
    <h1>{{ s.title }}</h1>
    <p class="lead">{{ s.intro }}</p>
    <p class="app-entry-intro">{{ s.launch.before }}<AppEntryLink :destination="{ kind: 'screen', screen: 'home' }" :locale="locale" display="path" />{{ s.launch.after }}</p>
    <p class="prerequisite">{{ s.setup.before }}<DocsLink :locale="locale" page="in-browser-models">{{ s.setup.browserLink }}</DocsLink>{{ s.setup.between }}<DocsLink :locale="locale" page="local-ai-servers">{{ s.setup.engineLink }}</DocsLink>{{ s.setup.after }} {{ s.setup.exampleBefore }}<AppEntryLink :destination="{ kind: 'model', model: 'hf.co/lmstudio-community/Qwen3.5-9B-GGUF:Q4_K_M' }" :locale="locale" display="label">{{ s.setup.exampleLink }}</AppEntryLink>{{ s.setup.exampleAfter }}</p>

    <section class="walkthrough-step">
      <h2>{{ s.steps.open.title }}</h2>
      <p><UiText :text="s.steps.open.body" /></p>
      <figure class="guide-figure"><WikipediaSettingsStep stage="open" :copy="s.demo" /><figcaption class="caption"><UiText :text="s.steps.open.caption" /></figcaption></figure>
    </section>

    <section class="walkthrough-step">
      <h2>{{ s.steps.enable.title }}</h2>
      <p><UiText :text="s.steps.enable.body" /></p>
      <figure class="guide-figure"><WikipediaSettingsStep stage="enabled" :copy="s.demo" /><figcaption class="caption"><UiText :text="s.steps.enable.caption" /></figcaption></figure>
      <p><UiText :text="s.steps.enable.sysfs.before" /><DocsLink :locale="locale" page="wesh-sysfs">{{ s.steps.enable.sysfs.link }}</DocsLink><UiText :text="s.steps.enable.sysfs.after" /></p>
    </section>

    <section class="walkthrough-step">
      <h2>{{ s.steps.search.title }}</h2>
      <p>{{ s.privacy.editions }} <DocsLink :locale="locale" page="csp-editions">{{ s.privacy.editionsLink }}</DocsLink></p>
      <p><UiText :text="s.steps.search.body" /></p>
      <figure class="guide-figure"><WikipediaChatStep stage="search" :copy="s.demo" /><figcaption class="caption"><UiText :text="s.steps.search.caption" /></figcaption></figure>
    </section>

    <section class="walkthrough-step">
      <h2>{{ s.steps.page.title }}</h2>
      <p><UiText :text="s.steps.page.body" /></p>
      <figure class="guide-figure"><WikipediaChatStep stage="page" :copy="s.demo" /><figcaption class="caption"><UiText :text="s.steps.page.caption" /></figcaption></figure>
    </section>

    <section class="result-section">
      <h2>{{ s.result.title }}</h2>
      <p>{{ s.result.body }}</p>
      <figure class="guide-figure"><WikipediaChatStep stage="result" :copy="s.demo" /></figure>
      <p>{{ s.result.help }}</p>
    </section>

    <section class="privacy-section">
      <h2>{{ s.privacy.title }}</h2>
      <p>{{ s.privacy.body }}</p>
      <figure class="privacy-figure">
        <div class="privacy-flow" role="img" :aria-label="s.privacy.diagram.caption">
          <div class="flow-node">{{ s.privacy.diagram.chat }}</div>
          <span class="flow-arrow" aria-hidden="true">→</span>
          <div class="flow-node broker">{{ s.privacy.diagram.broker }}</div>
          <span class="flow-arrow" aria-hidden="true">→</span>
          <div class="flow-node">{{ s.privacy.diagram.wiki }}</div>
          <div class="flow-label sent">{{ s.privacy.diagram.sent }}</div>
          <div class="flow-label origin">{{ s.privacy.diagram.origin }}</div>
        </div>
        <figcaption class="caption">{{ s.privacy.diagram.caption }}</figcaption>
      </figure>
      <p>{{ s.privacy.detail }}</p>
    </section>

    <RelatedGuide :locale="locale" :eyebrow="common.relatedGuides" :guides="[
      { page: 'tool-browser-shell', ...s.related.shell },
      { page: 'csp-editions', ...s.related.localOnly },
    ]" />
  </article>
</template>

<style scoped>
.walkthrough-step{border-top:1px solid var(--line);margin-top:37px;padding-top:21px}.walkthrough-step h2{margin-top:0}.walkthrough-step>p{margin-bottom:0}.walkthrough-step .guide-figure{margin:18px 0 0}.result-section,.privacy-section{margin-top:42px}.result-section .guide-figure{margin:20px 0}.privacy-figure{margin:23px 0 25px}.privacy-figure figcaption{margin-top:12px}.privacy-flow{display:grid;grid-template-columns:minmax(0,1fr) 28px minmax(0,1fr) 28px minmax(0,1fr);align-items:center;gap:8px;max-width:680px;margin-inline:auto;padding:20px;border:1px solid var(--line-strong);border-radius:13px;background:var(--surface);color:var(--text);font-size:12px}.flow-node{display:grid;place-items:center;min-height:70px;padding:9px;text-align:center;overflow-wrap:anywhere;border:1px solid var(--line-strong);border-radius:10px;background:var(--surface-2);font-weight:750}.flow-node.broker{border-color:var(--blue);color:var(--blue)}.flow-arrow{text-align:center;color:var(--blue);font-size:22px}.flow-label{grid-row:2;padding-top:6px;text-align:center;font-size:11px;line-height:1.5;font-weight:700;overflow-wrap:anywhere}.sent{grid-column:3 / 6;color:var(--green)}.origin{grid-column:1 / 3;color:var(--muted)}
@media(max-width:520px){.privacy-flow{grid-template-columns:minmax(0,1fr) 18px minmax(0,1fr) 18px minmax(0,1fr);gap:3px;padding:11px;font-size:10px}.flow-node{min-height:74px;padding:5px}.flow-arrow{font-size:16px}.flow-label{font-size:10px}}
</style>
