<script setup lang="ts">
import { computed } from 'vue';
import DocsLink from '../../components/DocsLink.vue';
import RenderText from '../../components/RenderText';
import RelatedGuide from '../../components/RelatedGuide.vue';
import type { DocsLocale } from '../../navigation/routes';
import type { CommonMessages, InBrowserModelsMessages } from '../../messages/types';

const props = defineProps<{ s: InBrowserModelsMessages; locale: DocsLocale; common: CommonMessages }>();

const choices = computed(() => [
  { title: props.s.llama_cpp_heading, guide: 'endpoint-type-llama-cpp-browser' as const, availability: props.s.llama_cpp_availability, body: props.s.llama_cpp_description },
  { title: props.s.transformers_js_heading, guide: 'endpoint-type-transformers-js' as const, availability: props.s.transformers_js_availability, body: props.s.transformers_js_description },
  { title: props.s.browser_provided_model_heading, guide: 'endpoint-type-browser-provided-lm' as const, availability: props.s.browser_provided_model_availability, body: props.s.browser_provided_model_description },
]);
const steps = computed(() => [
  { title: props.s.select_llama_cpp_heading, body: props.s.select_llama_cpp_instructions },
  { title: props.s.prepare_model_files_heading, body: props.s.prepare_model_files_instructions },
  { title: props.s.choose_conversation_model_heading, body: props.s.choose_conversation_model_instructions },
  { title: props.s.send_first_message_heading, body: props.s.send_first_message_instructions },
]);

defineExpose({
  ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}),
});
</script>

<template>
  <article class="prose" data-testid="docs-models-in-browser">
    <h1>{{ s.title }}</h1>
    <p v-for="paragraph in s.intro()" :key="paragraph" class="lead">{{ paragraph }}</p>

    <figure class="guide-figure model-flow" data-docs-animation="browser-model-flow">
      <div class="flow-track" aria-hidden="true">
        <span class="flow-node">{{ s.chat_message }}</span>
        <span class="flow-arrow">→</span>
        <span class="flow-node flow-focus">{{ s.browser_runtime_and_model }}</span>
        <span class="flow-arrow">→</span>
        <span class="flow-node">{{ s.chat_answer }}</span>
      </div>
      <figcaption class="caption">{{ s.browser_model_flow_caption }}</figcaption>
    </figure>

    <h2>{{ s.browser_runtime_choices_heading }}</h2>
    <div class="runtime-grid">
      <section v-for="choice in choices" :key="choice.title" class="panel runtime-card">
        <span class="runtime-availability">{{ choice.availability }}</span>
        <h3>{{ choice.title }}</h3>
        <p><RenderText :node="choice.body()" /></p>
        <DocsLink class="card-guide-link" :locale="locale" :page="choice.guide" :aria-label="`${choice.title}: ${s.view_setup_guide}`">{{ s.view_setup_guide }} <span aria-hidden="true">→</span></DocsLink>
      </section>
    </div>

    <h2>{{ s.start_gguf_chat_heading }}</h2>
    <ol class="guide-steps">
      <li v-for="step in steps" :key="step.title"><h3>{{ step.title }}</h3><p><RenderText :node="step.body()" /></p></li>
    </ol>

    <h2>{{ s.media_input_limits_heading }}</h2>
    <div class="guide-notes">
      <p v-for="paragraph in s.media_input_limits()" :key="paragraph">{{ paragraph }}</p>
    </div>
    <RelatedGuide :locale="locale" :eyebrow="common.related_guides" :guides="[{ page: 'local-ai-servers', title: s.local_server_guide_title, description: s.local_server_guide_description }]" />
  </article>
</template>

<style scoped>
.model-flow {
  margin-bottom: 42px;
}
.flow-track {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 9px;
  padding: 20px;
  border: 1px solid var(--line-strong);
  border-radius: 15px;
  background: var(--surface);
}
.flow-node {
  flex: 1;
  min-width: 0;
  padding: 14px 10px;
  border: 1px solid var(--line-strong);
  border-radius: 10px;
  background: var(--surface-2);
  font-size: 12px;
  line-height: 1.6;
  font-weight: 700;
  text-align: center;
  overflow-wrap: anywhere;
}
.flow-focus {
  border-color: var(--blue);
  animation: flow-emphasis 4s ease-in-out infinite;
}
.flow-arrow {
  flex: none;
  color: var(--blue);
  font-weight: 800;
}
@keyframes flow-emphasis {
  50% {
    box-shadow: 0 0 0 4px color-mix(in srgb,var(--blue) 13%,transparent);
  }
}
.runtime-grid {
  display: grid;
  grid-template-columns: repeat(3,minmax(0,1fr));
  gap: 14px;
}
.runtime-card {
  display: flex;
  flex-direction: column;
  min-width: 0;
  padding: 21px;
}
.runtime-card h3 {
  font-size: 18px;
  line-height: 1.45;
  margin: 14px 0 10px;
  overflow-wrap: anywhere;
}
.runtime-card p {
  font-size: 13px;
  line-height: 1.8;
}
.card-guide-link {
  display: inline-flex;
  align-items: center;
  align-self: flex-start;
  gap: 7px;
  margin-top: auto;
  padding-top: 12px;
  color: var(--blue);
  font-size: 12px;
  font-weight: 800;
  overflow-wrap: anywhere;
}
.card-guide-link:hover {
  text-decoration: underline;
}
.runtime-availability {
  display: block;
  color: var(--blue);
  font-size: 11px;
  line-height: 1.6;
  font-weight: 750;
}
.guide-notes {
  border-top: 1px solid var(--line);
}
.guide-notes p {
  border-bottom: 1px solid var(--line);
  margin: 0;
  padding: 19px 0;
}
@media(max-width:760px) {
  .runtime-grid {
    grid-template-columns: 1fr;
  }
}
@media(max-width:560px) {
  .flow-track {
    flex-direction: column;
    align-items: stretch;
  }
  .flow-arrow {
    align-self: center;
    transform: rotate(90deg);
  }
}
@media(prefers-reduced-motion:reduce) {
  .flow-focus {
    animation: none;
  }
}
</style>
