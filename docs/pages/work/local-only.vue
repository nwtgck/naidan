<script setup lang="ts">
import ExternalLink from '../../site/ExternalLink.vue';
import RelatedGuide from '../../site/RelatedGuide.vue';
import UiText from '../../site/UiText.vue';
import ConnectionPolicyDiagram from '../../site/demos/ConnectionPolicyDiagram.vue';
import { docsHref } from '../../site/routes';
import type { DocsLocale } from '../../site/routes';
import type { CommonMessages, LocalOnlyMessages } from '../../site/messages';

defineProps<{ s: LocalOnlyMessages; locale: DocsLocale; common: CommonMessages }>();

defineExpose({
  ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}),
});
</script>

<template>
  <article class="prose" data-testid="docs-local-only">
    <h1>{{ s.title }}</h1>
    <p class="lead">{{ s.intro }}</p>

    <section>
      <h2>{{ s.versionsTitle }}</h2>
      <div class="version-grid">
        <div v-for="version in [s.versions.localOnly, s.versions.curated, s.versions.standard]" :key="version.url" class="panel version-card">
          <h3>{{ version.title }}</h3>
          <p>{{ version.body }}</p>
          <code class="version-url">{{ version.url }}</code>
          <ExternalLink :href="version.url" :locale="locale">{{ version.link }}</ExternalLink>
        </div>
      </div>
      <p class="switching-note">{{ s.switching }} <a :href="docsHref({ locale, page: 'data/backup' })">{{ s.backupLink }}</a></p>
      <figure class="policy-figure"><ConnectionPolicyDiagram :s="s" /><figcaption>{{ s.diagram.caption }}</figcaption></figure>
    </section>

    <section>
      <h2>{{ s.localTitle }}</h2>
      <p>{{ s.localIntro }}</p>
      <dl class="allowed-destinations">
        <div v-for="item in s.allowed" :key="item.address">
          <dt><code>{{ item.address }}</code></dt>
          <dd>{{ item.meaning }}</dd>
        </div>
      </dl>
      <p>{{ s.localConditions }} <a :href="docsHref({ locale, page: 'models/local-engines' })">{{ s.localGuideLink }}</a></p>
    </section>

    <section>
      <h2>{{ s.scopeTitle }}</h2>
      <p>{{ s.scope }}</p>
      <p>{{ s.outsideScope }}</p>
    </section>

    <section>
      <h2>{{ s.checkTitle }}</h2>
      <ol class="guide-steps">
        <li v-for="step in s.checkSteps" :key="step.title"><h3>{{ step.title }}</h3><p><UiText :text="step.body" /></p></li>
      </ol>
      <p class="check-note"><UiText :text="s.checkNote" /></p>
    </section>

    <RelatedGuide :locale="locale" :eyebrow="common.relatedGuides" :guides="[{ page: 'models/local-engines', title: s.relatedLocalTitle, description: s.relatedLocalDescription }]" />
  </article>
</template>

<style scoped>
.version-grid { display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px; }
.version-card { display:flex;flex-direction:column;min-width:0;padding:20px; }
.version-card h3 { font-size:17px;line-height:1.5; }
.version-card p { flex:1;font-size:13px;line-height:1.75; }
.version-url { display:block;margin:17px 0 11px;overflow-wrap:anywhere;font-size:11px;line-height:1.6; }
.version-card a { align-self:flex-start;overflow-wrap:anywhere;font-size:13px;font-weight:700; }
.switching-note { margin-top:20px; }
.policy-figure { margin:27px 0 0; }
.policy-figure figcaption { margin-top:10px;color:var(--muted);font-size:12px;line-height:1.8; }
.allowed-destinations { margin:22px 0;padding:0;border:1px solid var(--line-strong);border-radius:14px;overflow:hidden; }
.allowed-destinations > div { display:grid;grid-template-columns:minmax(0,190px) minmax(0,1fr);gap:15px;padding:14px 18px;background:var(--surface); }
.allowed-destinations > div + div { border-top:1px solid var(--line); }
.allowed-destinations dt { overflow-wrap:anywhere; }
.allowed-destinations dd { margin:0;color:var(--muted);font-size:13px;line-height:1.75; }
.check-note { padding:16px 20px;border-left:3px solid var(--blue);border-radius:0 10px 10px 0;background:var(--surface); }
@media(max-width:800px) { .version-grid { grid-template-columns:1fr; } .version-card p { flex:none; } }
@media(max-width:560px) { .allowed-destinations > div { grid-template-columns:1fr;gap:4px; } }
</style>
