<script setup lang="ts">
import ExternalLink from '../../site/ExternalLink.vue';
import RelatedGuide from '../../site/RelatedGuide.vue';
import type { OpenSourceMessages, CommonMessages } from '../../site/messages';
import type { DocsLocale } from '../../site/routes';

defineProps<{ s: OpenSourceMessages; locale: DocsLocale; common: CommonMessages }>();

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <article class="prose" data-testid="docs-open-source">
    <h1>{{ s.title }}</h1>
    <p class="lead">{{ s.intro }}</p>

    <section class="open-source-section" aria-labelledby="open-source-repository">
      <h2 id="open-source-repository">{{ s.repository.title }}</h2>
      <ExternalLink href="https://github.com/nwtgck/naidan" :locale="locale">https://github.com/nwtgck/naidan</ExternalLink>
    </section>

    <section class="open-source-section" aria-labelledby="open-source-license">
      <h2 id="open-source-license">{{ s.license.title }}</h2>
      <p>{{ s.license.body }}</p>
      <ExternalLink href="https://github.com/nwtgck/naidan/blob/develop/LICENSE" :locale="locale">{{ s.license.link }}</ExternalLink>
      <p class="open-source-note">{{ s.license.note }}</p>
    </section>

    <section class="open-source-section" aria-labelledby="open-source-source">
      <h2 id="open-source-source">{{ s.source.title }}</h2>
      <p>{{ s.source.body }}</p>
      <div class="open-source-links">
        <ExternalLink href="https://github.com/nwtgck/naidan" :locale="locale">{{ s.source.link }}</ExternalLink>
        <ExternalLink href="https://github.com/nwtgck/naidan/commits" :locale="locale">{{ s.source.historyLink }}</ExternalLink>
      </div>
    </section>

    <section class="open-source-section" aria-labelledby="open-source-build">
      <h2 id="open-source-build">{{ s.build.title }}</h2>
      <p>{{ s.build.body }}</p>
      <p class="open-source-note">{{ s.build.note }}</p>
      <div class="open-source-links">
        <ExternalLink href="https://github.com/nwtgck/naidan/blob/develop/.github/workflows/main.yml" :locale="locale">{{ s.build.workflowLink }}</ExternalLink>
        <ExternalLink href="https://github.com/nwtgck/naidan/actions/workflows/main.yml" :locale="locale">{{ s.build.runsLink }}</ExternalLink>
      </div>
      <figure class="guide-figure open-source-figure" data-docs-animation="open-source-flow">
        <ol class="open-source-flow" :aria-label="s.build.diagramCaption">
          <li>{{ s.build.diagram.source }}</li>
          <li>{{ s.build.diagram.build }}</li>
          <li>{{ s.build.diagram.release }}</li>
        </ol>
        <figcaption class="caption">{{ s.build.diagramCaption }}</figcaption>
      </figure>
    </section>

    <section class="open-source-section" aria-labelledby="open-source-use">
      <h2 id="open-source-use">{{ s.use.title }}</h2>
      <p>{{ s.use.body }}</p>
      <div class="pair-grid">
        <section class="panel open-source-choice-card">
          <h3>{{ s.use.selfBuild.title }}</h3>
          <p>{{ s.use.selfBuild.body }}</p>
          <ExternalLink class="open-source-choice-link" href="https://github.com/nwtgck/naidan/blob/develop/README.md#development" :locale="locale">{{ s.use.selfBuild.link }}</ExternalLink>
        </section>
        <section class="panel open-source-choice-card">
          <h3>{{ s.use.release.title }}</h3>
          <p>{{ s.use.release.body }}</p>
          <ExternalLink class="open-source-choice-link" href="https://github.com/nwtgck/naidan/releases/latest" :locale="locale">{{ s.use.release.link }}</ExternalLink>
        </section>
      </div>
    </section>
    <RelatedGuide :locale="locale" :eyebrow="common.relatedGuides" :guides="[{ page: 'run/standalone', title: s.use.relatedTitle, description: s.use.relatedDescription }]" />
  </article>
</template>

<style scoped>
.open-source-section { border-top: 1px solid var(--line); margin-top: 38px; padding-top: 22px; }
.open-source-section h2 { margin-top: 0; }
.open-source-note { margin-top: 15px; font-size: 14px; }
.open-source-links { display: flex; flex-wrap: wrap; gap: 5px 22px; margin-top: 10px; font-size: 14px; }
.open-source-figure { padding: 24px; border: 1px solid var(--line-strong); border-radius: 17px; background: var(--surface); }
.open-source-figure figcaption { margin-bottom: 0; }
.open-source-flow { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 28px; margin: 0; padding: 0; list-style: none; }
.open-source-flow li { position: relative; display: flex; min-height: 74px; align-items: center; justify-content: center; padding: 15px; border: 1px solid var(--line-strong); border-radius: 12px; background: var(--surface-2); color: var(--text); font-size: 13px; font-weight: 700; line-height: 1.5; text-align: center; animation: open-source-appear .55s ease-out both; }
.open-source-flow li + li::before { content: '→'; position: absolute; right: calc(100% + 7px); color: var(--blue); font-size: 21px; font-weight: 400; }
.open-source-flow li:nth-child(2) { animation-delay: .12s; }
.open-source-flow li:nth-child(3) { animation-delay: .24s; }
.panel p { margin-bottom: 12px; }
.panel a { font-size: 14px; }
.open-source-choice-card { display: flex; flex-direction: column; min-width: 0; }
.open-source-choice-link { align-self: flex-start; margin-top: auto; }
@keyframes open-source-appear { from { opacity: .45; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }
@media (max-width: 700px) {
  .open-source-flow { grid-template-columns: 1fr; gap: 26px; }
  .open-source-flow li { min-height: 58px; }
  .open-source-flow li + li::before { content: '↓'; left: 50%; right: auto; bottom: calc(100% + 1px); transform: translateX(-50%); }
}
@media (prefers-reduced-motion: reduce) { .open-source-flow li { animation: none; } }
html:has(#docs-pause-motion:checked) .open-source-flow li { animation: none; }
</style>
