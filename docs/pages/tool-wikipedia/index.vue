<script setup lang="ts">
import RelatedGuide from '../../components/RelatedGuide.vue';
import RenderText from '../../components/RenderText';
import WikipediaChatStep from '../../components/demos/WikipediaChatStep.vue';
import WikipediaSettingsStep from '../../components/demos/WikipediaSettingsStep.vue';
import type { DocsLocale } from '../../navigation/routes';
import type { CommonMessages, WikipediaMessages } from '../../messages/types';

defineProps<{ s: WikipediaMessages; locale: DocsLocale; common: CommonMessages }>();
defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <article class="prose" data-testid="docs-wikipedia">
    <h1>{{ s.title }}</h1>
    <p class="lead">{{ s.intro }}</p>
    <p class="app-entry-intro"><RenderText :node="s.open_wikipedia_chat({ locale, destination: { kind: 'screen', screen: 'home' } })" /></p>
    <p class="prerequisite"><RenderText :node="s.choose_tool_capable_model({ locale, browserPage: 'in-browser-models', enginePage: 'local-ai-servers', modelDestination: { kind: 'model', model: 'hf.co/lmstudio-community/Qwen3.5-9B-GGUF:Q4_K_M' } })" /></p>

    <section class="walkthrough-step">
      <h2>{{ s.open_tool_settings_title }}</h2>
      <p><RenderText :node="s.open_tool_settings_body()" /></p>
      <figure class="guide-figure"><WikipediaSettingsStep stage="open" :messages="s" :common="common" /><figcaption class="caption"><RenderText :node="s.open_tool_settings_caption()" /></figcaption></figure>
    </section>

    <section class="walkthrough-step">
      <h2>{{ s.enable_wikipedia_title }}</h2>
      <p><RenderText :node="s.enable_wikipedia_body()" /></p>
      <figure class="guide-figure"><WikipediaSettingsStep stage="enabled" :messages="s" :common="common" /><figcaption class="caption">{{ s.enable_wikipedia_caption }}</figcaption></figure>
      <p><RenderText :node="s.wikipedia_sysfs_guide({ locale, page: 'wesh-sysfs' })" /></p>
    </section>

    <section class="walkthrough-step">
      <h2>{{ s.approve_search_title }}</h2>
      <p><RenderText :node="s.wikipedia_editions_note({ locale, page: 'csp-editions' })" /></p>
      <p><RenderText :node="s.approve_search_body()" /></p>
      <figure class="guide-figure"><WikipediaChatStep stage="search" :messages="s" :common="common" /><figcaption class="caption">{{ s.approve_search_caption }}</figcaption></figure>
    </section>

    <section class="walkthrough-step">
      <h2>{{ s.approve_page_title }}</h2>
      <p><RenderText :node="s.approve_page_body()" /></p>
      <figure class="guide-figure"><WikipediaChatStep stage="page" :messages="s" :common="common" /><figcaption class="caption">{{ s.approve_page_caption }}</figcaption></figure>
    </section>

    <section class="result-section">
      <h2>{{ s.use_search_results_title }}</h2>
      <p>{{ s.use_search_results_body }}</p>
      <figure class="guide-figure"><WikipediaChatStep stage="result" :messages="s" :common="common" /></figure>
      <p>{{ s.use_search_results_help }}</p>
    </section>

    <section class="privacy-section">
      <h2>{{ s.wikipedia_privacy_title }}</h2>
      <p>{{ s.wikipedia_privacy_body }}</p>
      <figure class="privacy-figure">
        <div class="privacy-flow" role="img" :aria-label="s.request_flow_caption">
          <div class="flow-node">{{ s.request_flow_chat }}</div>
          <span class="flow-arrow" aria-hidden="true">→</span>
          <div class="flow-node broker">{{ s.request_flow_broker }}</div>
          <span class="flow-arrow" aria-hidden="true">→</span>
          <div class="flow-node">{{ s.request_flow_wikipedia }}</div>
          <div class="flow-label sent">{{ s.request_flow_sent_data }}</div>
          <div class="flow-label origin">{{ s.request_flow_origin }}</div>
        </div>
        <figcaption class="caption">{{ s.request_flow_caption }}</figcaption>
      </figure>
      <p>{{ s.wikipedia_privacy_detail }}</p>
    </section>

    <RelatedGuide :locale="locale" :eyebrow="common.related_guides" :guides="[
      { page: 'tool-browser-shell', title: s.shell_guide_title, description: s.shell_guide_description },
      { page: 'csp-editions', title: s.local_only_guide_title, description: s.local_only_guide_description },
    ]" />
  </article>
</template>

<style scoped>
.walkthrough-step {
  border-top: 1px solid var(--line);
  margin-top: 37px;
  padding-top: 21px;
}
.walkthrough-step h2 {
  margin-top: 0;
}
.walkthrough-step>p {
  margin-bottom: 0;
}
.walkthrough-step .guide-figure {
  margin: 18px 0 0;
}
.result-section,.privacy-section {
  margin-top: 42px;
}
.result-section .guide-figure {
  margin: 20px 0;
}
.privacy-figure {
  margin: 23px 0 25px;
}
.privacy-figure figcaption {
  margin-top: 12px;
}
.privacy-flow {
  display: grid;
  grid-template-columns: minmax(0,1fr) 28px minmax(0,1fr) 28px minmax(0,1fr);
  align-items: center;
  gap: 8px;
  max-width: 680px;
  margin-inline: auto;
  padding: 20px;
  border: 1px solid var(--line-strong);
  border-radius: 13px;
  background: var(--surface);
  color: var(--text);
  font-size: 12px;
}
.flow-node {
  display: grid;
  place-items: center;
  min-height: 70px;
  padding: 9px;
  text-align: center;
  overflow-wrap: anywhere;
  border: 1px solid var(--line-strong);
  border-radius: 10px;
  background: var(--surface-2);
  font-weight: 750;
}
.flow-node.broker {
  border-color: var(--blue);
  color: var(--blue);
}
.flow-arrow {
  text-align: center;
  color: var(--blue);
  font-size: 22px;
}
.flow-label {
  grid-row: 2;
  padding-top: 6px;
  text-align: center;
  font-size: 11px;
  line-height: 1.5;
  font-weight: 700;
  overflow-wrap: anywhere;
}
.sent {
  grid-column: 3 / 6;
  color: var(--green);
}
.origin {
  grid-column: 1 / 3;
  color: var(--muted);
}
@media(max-width:520px) {
  .privacy-flow {
    grid-template-columns: minmax(0,1fr) 18px minmax(0,1fr) 18px minmax(0,1fr);
    gap: 3px;
    padding: 11px;
    font-size: 10px;
  }
  .flow-node {
    min-height: 74px;
    padding: 5px;
  }
  .flow-arrow {
    font-size: 16px;
  }
  .flow-label {
    font-size: 10px;
  }
}
</style>
