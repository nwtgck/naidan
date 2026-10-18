<script setup lang="ts">
import { computed } from 'vue';
import DocsLink from '../../components/DocsLink.vue';
import RenderText from '../../components/RenderText';
import RelatedGuide from '../../components/RelatedGuide.vue';
import type { DocsLocale } from '../../navigation/routes';
import type { CommonMessages, LocalEnginesMessages } from '../../messages/types';

const props = defineProps<{ s: LocalEnginesMessages; locale: DocsLocale; common: CommonMessages }>();

const engines = computed(() => [
  { title: props.s.ollama_heading, guide: 'endpoint-type-ollama' as const, provider: props.s.ollama_provider_label, preset: props.s.ollama_preset, body: props.s.ollama_description },
  { title: props.s.llama_cpp_server_heading, guide: 'endpoint-type-openai' as const, provider: props.s.llama_cpp_server_provider_label, preset: props.s.llama_cpp_server_preset, body: props.s.llama_cpp_server_description },
]);
const steps = computed(() => [
  { title: props.s.start_engine_heading, body: props.s.start_engine_instructions },
  { title: props.s.choose_provider_and_url_heading, body: props.s.choose_provider_and_url_instructions },
  { title: props.s.check_connection_and_model_heading, body: props.s.check_connection_and_model_instructions },
]);
const troubleItems = computed(() => [
  { title: props.s.wrong_address_or_api_heading, body: props.s.wrong_address_or_api_description },
  { title: props.s.browser_blocks_request_heading, body: props.s.browser_blocks_request_description },
  { title: props.s.empty_model_list_heading, body: props.s.empty_model_list_description },
]);

defineExpose({
  ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}),
});
</script>

<template>
  <article class="prose" data-testid="docs-models-local-engines">
    <h1>{{ s.title }}</h1>
    <p v-for="paragraph in s.intro()" :key="paragraph" class="lead">{{ paragraph }}</p>

    <figure class="guide-figure model-flow" data-docs-animation="local-engine-flow">
      <div class="flow-track" aria-hidden="true">
        <span class="flow-node">{{ s.browser_chat }}</span>
        <span class="flow-arrow">↔</span>
        <span class="flow-node flow-focus">{{ s.local_api_request }}</span>
        <span class="flow-arrow">↔</span>
        <span class="flow-node">{{ s.model_server }}</span>
      </div>
      <figcaption class="caption">{{ s.local_server_flow_caption }}</figcaption>
    </figure>

    <h2>{{ s.local_engine_choices_heading }}</h2>
    <div class="pair-grid">
      <section v-for="engine in engines" :key="engine.title" class="panel engine-card">
        <h3>{{ engine.title }}</h3>
        <p class="engine-provider">{{ engine.provider }}</p>
        <code class="engine-preset">{{ engine.preset }}</code>
        <p><RenderText :node="engine.body()" /></p>
        <DocsLink class="card-guide-link" :locale="locale" :page="engine.guide" :aria-label="`${engine.title}: ${s.view_setup_guide}`">{{ s.view_setup_guide }} <span aria-hidden="true">→</span></DocsLink>
      </section>
    </div>

    <h2>{{ s.first_run_connection_heading }}</h2>
    <ol class="guide-steps">
      <li v-for="step in steps" :key="step.title"><h3>{{ step.title }}</h3><p><RenderText :node="step.body()" /></p></li>
    </ol>

    <h2>{{ s.change_connection_heading }}</h2>
    <p><RenderText :node="s.change_connection_instructions()" /></p>

    <h2>{{ s.connection_troubleshooting_heading }}</h2>
    <div class="decision-list">
      <section v-for="(item, index) in troubleItems" :key="item.title">
        <span aria-hidden="true">0{{ index + 1 }}</span>
        <div><h3>{{ item.title }}</h3><p><RenderText :node="item.body()" /></p></div>
      </section>
    </div>
    <p class="connection-boundary">{{ s.local_server_data_boundary }}</p>
    <RelatedGuide :locale="locale" :eyebrow="common.related_guides" :guides="[{ page: 'in-browser-models', title: s.browser_model_guide_title, description: s.browser_model_guide_description }]" />
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
.engine-card {
  display: flex;
  flex-direction: column;
  min-width: 0;
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
.engine-provider {
  font-weight: 700;
  color: var(--text);
}
.engine-preset {
  display: block;
  max-width: 100%;
  overflow-wrap: anywhere;
  margin: 12px 0 16px;
  padding: 11px 13px;
  border: 1px solid var(--line);
  border-radius: 9px;
  background: var(--surface-2);
  font-size: 12px;
  line-height: 1.7;
}
.connection-boundary {
  padding: 19px 22px;
  border-left: 3px solid var(--blue);
  background: var(--surface);
  border-radius: 0 10px 10px 0;
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
