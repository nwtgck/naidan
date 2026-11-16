<script setup lang="ts">
import RenderText from '../../components/RenderText';
import RelatedGuide from '../../components/RelatedGuide.vue';
import MultiPromptImageGuideStep from '../../components/demos/MultiPromptImageGuideStep.vue';
import type { CommonMessages, MultiPromptImageGuideMessages } from '../../messages/types';
import type { DocsLocale } from '../../navigation/routes';
import { multiPromptImageExamples } from './examples';

const props = defineProps<{ s: MultiPromptImageGuideMessages; locale: DocsLocale; common: CommonMessages }>();
const examples = multiPromptImageExamples({ prompts: [props.s.sky_prompt, props.s.garden_prompt, props.s.bookshelf_prompt] });
defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <article class="prose" data-testid="docs-multi-prompt-image">
    <h1>{{ s.title }}</h1>
    <p class="lead">{{ s.intro }}</p>
    <p class="app-entry-intro"><RenderText :node="s.open_workspace({ locale, destination: { kind: 'screen', screen: 'image-generation' } })" /></p>
    <p><RenderText :node="s.distinguish_inputs()" /></p>
    <figure class="guide-figure">
      <div class="request-flow" role="img" :aria-label="s.flow_caption">
        <div><strong>{{ s.flow_requests }}</strong><span>1 · {{ s.sky_short }}</span><span>2 · {{ s.garden_short }}</span><span>3 · {{ s.bookshelf_short }}</span></div>
        <span class="flow-arrow" aria-hidden="true">→</span>
        <div class="model-node"><strong>{{ s.flow_model }}</strong><span>{{ s.model_name }}</span></div>
        <span class="flow-arrow" aria-hidden="true">→</span>
        <div><strong>{{ s.flow_results }}</strong><span>1 → 2 → 3</span></div>
      </div>
      <figcaption class="caption">{{ s.flow_caption }}</figcaption>
    </figure>

    <section class="walkthrough-step" aria-labelledby="multi-common">
      <h2 id="multi-common">{{ s.common_title }}</h2>
      <p><RenderText :node="s.common_body()" /></p>
      <figure class="guide-figure"><MultiPromptImageGuideStep stage="common" :messages="s" /><figcaption class="caption">{{ s.common_caption }}</figcaption></figure>
    </section>
    <section class="walkthrough-step" aria-labelledby="multi-inputs">
      <h2 id="multi-inputs">{{ s.inputs_title }}</h2>
      <p><RenderText :node="s.inputs_body()" /></p>
      <figure class="guide-figure"><MultiPromptImageGuideStep stage="inputs" :messages="s" /><figcaption class="caption">{{ s.inputs_caption }}</figcaption></figure>
    </section>
    <section class="walkthrough-step" aria-labelledby="multi-overrides">
      <h2 id="multi-overrides">{{ s.overrides_title }}</h2>
      <p><RenderText :node="s.override_body()" /></p>
      <figure class="guide-figure"><MultiPromptImageGuideStep stage="overrides" :messages="s" /><figcaption class="caption">{{ s.overrides_caption }}</figcaption></figure>
    </section>
    <section class="walkthrough-step" aria-labelledby="multi-generate">
      <h2 id="multi-generate">{{ s.generate_title }}</h2>
      <p><RenderText :node="s.generate_body()" /></p>
      <figure class="guide-figure"><MultiPromptImageGuideStep stage="generate" :messages="s" /><figcaption class="caption">{{ s.generate_caption }}</figcaption></figure>
      <p><RenderText :node="s.stopping_body()" /></p>
    </section>
    <section class="walkthrough-step" aria-labelledby="multi-compare">
      <h2 id="multi-compare">{{ s.compare_title }}</h2>
      <p><RenderText :node="s.compare_body()" /></p>
      <figure class="guide-figure"><MultiPromptImageGuideStep stage="compare" :messages="s" /><figcaption class="caption">{{ s.compare_caption }}</figcaption></figure>
    </section>
    <section class="walkthrough-step" aria-labelledby="multi-save">
      <h2 id="multi-save">{{ s.save_title }}</h2>
      <p><RenderText :node="s.save_body()" /></p>
      <figure class="guide-figure"><MultiPromptImageGuideStep stage="save" :messages="s" /><figcaption class="caption">{{ s.save_caption }}</figcaption></figure>
      <p><RenderText :node="s.zip_contents()" /></p>
      <p><RenderText :node="s.recovery_body()" /></p>
    </section>
    <section class="walkthrough-step" aria-labelledby="multi-paste">
      <h2 id="multi-paste">{{ s.paste_title }}</h2>
      <p><RenderText :node="s.paste_body()" /></p>
      <figure class="guide-figure"><MultiPromptImageGuideStep stage="paste" :messages="s" /><figcaption class="caption">{{ s.paste_caption }}</figcaption></figure>
      <p>{{ s.paste_formats }}</p>
      <div class="input-examples" data-testid="multi-prompt-examples">
        <section aria-labelledby="multi-yaml"><h3 id="multi-yaml">YAML</h3><pre><code data-testid="multi-prompt-yaml">{{ examples.yaml }}</code></pre></section>
        <section aria-labelledby="multi-jsonl"><h3 id="multi-jsonl">JSONL</h3><pre><code data-testid="multi-prompt-jsonl">{{ examples.jsonl }}</code></pre></section>
      </div>
      <p>{{ s.paste_values }}</p>
      <p><RenderText :node="s.remote_note({ locale, page: 'endpoint-type-naidan-rpc' })" /></p>
    </section>
    <RelatedGuide :locale="locale" :eyebrow="common.related_guides" :guides="[
      { page: 'image-generation', title: s.image_guide_title, description: s.image_guide_description },
      { page: 'workflow', title: s.workflow_guide_title, description: s.workflow_guide_description },
    ]" />
  </article>
</template>

<style scoped>
.walkthrough-step {
  margin-top: 36px;
  padding-top: 22px;
  border-top: 1px solid var(--line);
}
.walkthrough-step h2 {
  margin-top: 0;
}
.walkthrough-step .guide-figure {
  margin: 18px 0;
}
.request-flow {
  display: grid;
  grid-template-columns: minmax(0,1fr) 22px minmax(0,1fr) 22px minmax(0,1fr);
  align-items: center;
  gap: 10px;
  max-width: 680px;
  margin-inline: auto;
  padding: 20px;
  border: 1px solid var(--line-strong);
  border-radius: 14px;
  background: var(--surface);
  font-size: 12px;
}
.request-flow > div {
  display: grid;
  align-content: center;
  gap: 8px;
  min-height: 122px;
  min-width: 0;
  padding: 12px;
  border: 1px solid var(--line-strong);
  border-radius: 10px;
  overflow-wrap: anywhere;
}
.request-flow span {
  color: var(--muted);
}
.request-flow .model-node {
  border-color: var(--blue);
  color: var(--blue);
  background: var(--surface-2);
}
.request-flow .flow-arrow {
  text-align: center;
  color: var(--blue);
  font-size: 22px;
}
.input-examples {
  min-width: 0;
}
.input-examples pre {
  max-width: 100%;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
@media(max-width:520px) {
  .request-flow {
    grid-template-columns: minmax(0,1fr);
    gap: 8px;
    padding: 14px;
  }
  .request-flow > div {
    min-height: 0;
  }
  .request-flow .flow-arrow {
    line-height: 1;
    transform: rotate(90deg);
  }
}
</style>
