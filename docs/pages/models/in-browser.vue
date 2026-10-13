<script setup lang="ts">
import UiText from '../../site/UiText.vue';
import { docsHref } from '../../site/routes';
import type { DocsLocale } from '../../site/routes';
import type { CommonMessages, InBrowserModelsMessages } from '../../site/messages';

defineProps<{ s: InBrowserModelsMessages; locale: DocsLocale; common: CommonMessages }>();

defineExpose({
  ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}),
});
</script>

<template>
  <article class="prose" data-testid="docs-models-in-browser">
    <h1>{{ s.title }}</h1>
    <p v-for="paragraph in s.intro" :key="paragraph" class="lead"><UiText :text="paragraph" /></p>

    <figure class="guide-figure model-flow" data-docs-animation="browser-model-flow">
      <div class="flow-track" aria-hidden="true">
        <span class="flow-node">{{ s.flow.input }}</span>
        <span class="flow-arrow">→</span>
        <span class="flow-node flow-focus">{{ s.flow.execution }}</span>
        <span class="flow-arrow">→</span>
        <span class="flow-node">{{ s.flow.output }}</span>
      </div>
      <figcaption class="caption"><UiText :text="s.flow.caption" /></figcaption>
    </figure>

    <h2>{{ s.choicesTitle }}</h2>
    <div class="runtime-grid">
      <section v-for="choice in s.choices" :key="choice.title" class="panel runtime-card">
        <span class="runtime-availability">{{ choice.availability }}</span>
        <h3>{{ choice.title }}</h3>
        <p><UiText :text="choice.body" /></p>
        <a class="card-guide-link" :href="docsHref({ locale, page: choice.guide })">{{ s.openGuide }} <span aria-hidden="true">→</span></a>
      </section>
    </div>

    <h2>{{ s.stepsTitle }}</h2>
    <ol class="guide-steps">
      <li v-for="step in s.steps" :key="step.title"><h3>{{ step.title }}</h3><p><UiText :text="step.body" /></p></li>
    </ol>

    <h2>{{ s.limitsTitle }}</h2>
    <div class="guide-notes">
      <p v-for="paragraph in s.limits" :key="paragraph"><UiText :text="paragraph" /></p>
    </div>
    <a class="next-link" :href="docsHref({ locale, page: 'models/local-engines' })">{{ s.next }} <span aria-hidden="true">→</span></a>
  </article>
</template>

<style scoped>
.model-flow { margin-bottom:42px; }
.flow-track { display:flex;align-items:center;justify-content:center;gap:9px;padding:20px;border:1px solid var(--line-strong);border-radius:15px;background:var(--surface); }
.flow-node { flex:1;min-width:0;padding:14px 10px;border:1px solid var(--line-strong);border-radius:10px;background:var(--surface-2);font-size:12px;line-height:1.6;font-weight:700;text-align:center;overflow-wrap:anywhere; }
.flow-focus { border-color:var(--blue);animation:flow-emphasis 4s ease-in-out infinite; }
.flow-arrow { flex:none;color:var(--blue);font-weight:800; }
@keyframes flow-emphasis { 50% { box-shadow:0 0 0 4px color-mix(in srgb,var(--blue) 13%,transparent); } }
.runtime-grid { display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px; }
.runtime-card { min-width:0;padding:21px; }
.runtime-card h3 { font-size:18px;line-height:1.45;margin:14px 0 10px;overflow-wrap:anywhere; }
.runtime-card p { font-size:13px;line-height:1.8; }
.card-guide-link { display:inline-flex;align-items:center;gap:7px;margin-top:5px;color:var(--blue);font-size:12px;font-weight:800;overflow-wrap:anywhere; }
.card-guide-link:hover { text-decoration:underline; }
.runtime-availability { display:block;color:var(--blue);font-size:11px;line-height:1.6;font-weight:750; }
.guide-notes { border-top:1px solid var(--line); }
.guide-notes p { border-bottom:1px solid var(--line);margin:0;padding:19px 0; }
@media(max-width:760px) { .runtime-grid { grid-template-columns:1fr; } }
@media(max-width:560px) { .flow-track { flex-direction:column;align-items:stretch; } .flow-arrow { align-self:center;transform:rotate(90deg); } }
@media(prefers-reduced-motion:reduce) { .flow-focus { animation:none; } }
</style>
