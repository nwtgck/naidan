<script setup lang="ts">
import RenderText from '../../components/RenderText';
import WorkflowFlowDiagram from '../../components/demos/WorkflowFlowDiagram.vue';
import WorkflowGuideStep from '../../components/demos/WorkflowGuideStep.vue';
import type { CommonMessages, WorkflowGuideMessages } from '../../messages/types';
import type { DocsLocale } from '../../navigation/routes';
import { createWorkflowGuideExample } from './example';

defineProps<{ s: WorkflowGuideMessages; locale: DocsLocale; common: CommonMessages }>();

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <article class="prose" data-testid="docs-workflow">
    <h1>{{ s.title }}</h1>
    <p class="lead">{{ s.lead }}</p>
    <p class="app-entry-intro"><RenderText :node="s.open_workflows({ locale })" /></p>
    <figure class="guide-figure"><WorkflowFlowDiagram :messages="s" /><figcaption class="caption">{{ s.flow_caption }}</figcaption></figure>

    <section class="workflow-step" aria-labelledby="workflow-build">
      <h2 id="workflow-build">{{ s.build_title }}</h2>
      <p><RenderText :node="s.create_steps()" /></p>
      <ol class="example-steps">
        <li><p><RenderText :node="s.input_setup()" /></p><blockquote>{{ s.input_prompt }}</blockquote></li>
        <li><p><RenderText :node="s.summary_setup()" /></p><blockquote>{{ s.summary_instruction }}</blockquote></li>
        <li><p><RenderText :node="s.share_setup()" /></p><blockquote>{{ s.share_instruction }}</blockquote></li>
      </ol>
      <figure class="guide-figure"><WorkflowGuideStep stage="edit" :messages="s" /><figcaption class="caption">{{ s.reference_caption }}</figcaption></figure>
      <details class="example-json"><summary>{{ s.optional_example }}</summary><p><RenderText :node="s.paste_example()" /></p><pre data-testid="workflow-example-json"><code>{{ JSON.stringify(createWorkflowGuideExample({ messages: s }), undefined, 2) }}</code></pre></details>
    </section>

    <section class="workflow-step" aria-labelledby="workflow-connection">
      <h2 id="workflow-connection">{{ s.connection_title }}</h2>
      <p><RenderText :node="s.connection_setup({ locale })" /></p>
      <p><RenderText :node="s.connection_scope()" /></p>
      <figure class="guide-figure"><WorkflowGuideStep stage="connection" :messages="s" /><figcaption class="caption">{{ s.connection_caption }}</figcaption></figure>
    </section>

    <section class="workflow-step" aria-labelledby="workflow-run">
      <h2 id="workflow-run">{{ s.run_title }}</h2>
      <p><RenderText :node="s.run_steps()" /></p>
      <blockquote>{{ s.notes_example }}</blockquote>
      <p>{{ s.run_review }}</p>
      <figure class="guide-figure"><WorkflowGuideStep stage="run" :messages="s" /><figcaption class="caption">{{ s.run_caption }}</figcaption></figure>
    </section>

    <section class="workflow-step" aria-labelledby="workflow-results">
      <h2 id="workflow-results">{{ s.results_title }}</h2>
      <p><RenderText :node="s.inspect_results()" /></p>
      <figure class="guide-figure"><WorkflowGuideStep stage="results" :messages="s" /><figcaption class="caption">{{ s.results_caption }}</figcaption></figure>
      <p><RenderText :node="s.inspect_history()" /></p>
    </section>

    <section class="workflow-step" aria-labelledby="workflow-reuse">
      <h2 id="workflow-reuse">{{ s.reuse_title }}</h2>
      <p><RenderText :node="s.save_and_reuse()" /></p>
      <blockquote>{{ s.next_notes_example }}</blockquote>
      <figure class="guide-figure"><WorkflowGuideStep stage="reuse" :messages="s" /><figcaption class="caption">{{ s.reuse_caption }}</figcaption></figure>
      <p><RenderText :node="s.saving_conditions({ locale })" /></p>
    </section>
  </article>
</template>

<style scoped>
.workflow-step {
  border-top: 1px solid var(--line);
  margin-top: 36px;
  padding-top: 22px;
}
.workflow-step h2 {
  margin-top: 0;
}
.workflow-step .guide-figure {
  margin: 18px 0;
}
.example-steps {
  padding-inline-start: 24px;
}
.example-steps li {
  padding-inline-start: 5px;
}
.example-steps blockquote {
  margin-inline: 0;
}
.example-json {
  margin-top: 22px;
}
.example-json summary {
  cursor: pointer;
  color: var(--blue);
}
.example-json pre {
  max-height: 340px;
  overflow: auto;
  font-size: 12px;
}
</style>
