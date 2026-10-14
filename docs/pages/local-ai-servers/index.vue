<script setup lang="ts">
import DocsLink from '../../site/DocsLink.vue';
import UiText from '../../site/UiText.vue';
import RelatedGuide from '../../site/RelatedGuide.vue';
import type { DocsLocale } from '../../site/routes';
import type { CommonMessages, LocalEnginesMessages } from '../../site/messages';

defineProps<{ s: LocalEnginesMessages; locale: DocsLocale; common: CommonMessages }>();

defineExpose({
  ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}),
});
</script>

<template>
  <article class="prose" data-testid="docs-models-local-engines">
    <h1>{{ s.title }}</h1>
    <p v-for="paragraph in s.intro" :key="paragraph" class="lead"><UiText :text="paragraph" /></p>

    <figure class="guide-figure model-flow" data-docs-animation="local-engine-flow">
      <div class="flow-track" aria-hidden="true">
        <span class="flow-node">{{ s.flow.browser }}</span>
        <span class="flow-arrow">↔</span>
        <span class="flow-node flow-focus">{{ s.flow.connection }}</span>
        <span class="flow-arrow">↔</span>
        <span class="flow-node">{{ s.flow.engine }}</span>
      </div>
      <figcaption class="caption"><UiText :text="s.flow.caption" /></figcaption>
    </figure>

    <h2>{{ s.enginesTitle }}</h2>
    <div class="pair-grid">
      <section v-for="engine in s.engines" :key="engine.title" class="panel engine-card">
        <h3>{{ engine.title }}</h3>
        <p class="engine-provider"><UiText :text="engine.provider" /></p>
        <code class="engine-preset">{{ engine.preset }}</code>
        <p><UiText :text="engine.body" /></p>
        <DocsLink class="card-guide-link" :locale="locale" :page="engine.guide" :aria-label="`${engine.title}: ${s.openGuide}`">{{ s.openGuide }} <span aria-hidden="true">→</span></DocsLink>
      </section>
    </div>

    <h2>{{ s.stepsTitle }}</h2>
    <ol class="guide-steps">
      <li v-for="step in s.steps" :key="step.title"><h3>{{ step.title }}</h3><p><UiText :text="step.body" /></p></li>
    </ol>

    <h2>{{ s.laterTitle }}</h2>
    <p><UiText :text="s.later" /></p>

    <h2>{{ s.troubleTitle }}</h2>
    <div class="decision-list">
      <section v-for="(item, index) in s.trouble" :key="item.title">
        <span aria-hidden="true">0{{ index + 1 }}</span>
        <div><h3>{{ item.title }}</h3><p><UiText :text="item.body" /></p></div>
      </section>
    </div>
    <p class="connection-boundary"><UiText :text="s.boundary" /></p>
    <RelatedGuide :locale="locale" :eyebrow="common.relatedGuides" :guides="[{ page: 'in-browser-models', title: s.next, description: s.nextDescription }]" />
  </article>
</template>

<style scoped>
.model-flow { margin-bottom:42px; }
.flow-track { display:flex;align-items:center;justify-content:center;gap:9px;padding:20px;border:1px solid var(--line-strong);border-radius:15px;background:var(--surface); }
.flow-node { flex:1;min-width:0;padding:14px 10px;border:1px solid var(--line-strong);border-radius:10px;background:var(--surface-2);font-size:12px;line-height:1.6;font-weight:700;text-align:center;overflow-wrap:anywhere; }
.flow-focus { border-color:var(--blue);animation:flow-emphasis 4s ease-in-out infinite; }
.flow-arrow { flex:none;color:var(--blue);font-weight:800; }
@keyframes flow-emphasis { 50% { box-shadow:0 0 0 4px color-mix(in srgb,var(--blue) 13%,transparent); } }
.engine-card { display:flex;flex-direction:column;min-width:0; }
.card-guide-link { display:inline-flex;align-items:center;align-self:flex-start;gap:7px;margin-top:auto;padding-top:12px;color:var(--blue);font-size:12px;font-weight:800;overflow-wrap:anywhere; }
.card-guide-link:hover { text-decoration:underline; }
.engine-provider { font-weight:700;color:var(--text); }
.engine-preset { display:block;max-width:100%;overflow-wrap:anywhere;margin:12px 0 16px;padding:11px 13px;border:1px solid var(--line);border-radius:9px;background:var(--surface-2);font-size:12px;line-height:1.7; }
.connection-boundary { padding:19px 22px;border-left:3px solid var(--blue);background:var(--surface);border-radius:0 10px 10px 0; }
@media(max-width:560px) { .flow-track { flex-direction:column;align-items:stretch; } .flow-arrow { align-self:center;transform:rotate(90deg); } }
@media(prefers-reduced-motion:reduce) { .flow-focus { animation:none; } }
</style>
