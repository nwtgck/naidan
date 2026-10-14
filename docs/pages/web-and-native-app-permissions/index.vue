<script setup lang="ts">
import DocsLink from '../../site/DocsLink.vue';
import ExternalLink from '../../site/ExternalLink.vue';
import RelatedGuide from '../../site/RelatedGuide.vue';
import AppPermissionsDiagram from '../../site/demos/AppPermissionsDiagram.vue';
import type { DocsLocale } from '../../site/routes';
import type { AppPermissionsMessages, CommonMessages } from '../../site/messages';

const props = defineProps<{ s: AppPermissionsMessages; locale: DocsLocale; common: CommonMessages }>();
const accessCases = [
  { mode: 'desktop' as const, card: props.s.reach.cards[0]!, caption: props.s.visual.desktop.caption },
  { mode: 'mobile' as const, card: props.s.reach.cards[1]!, caption: props.s.visual.mobile.caption },
  { mode: 'web' as const, card: props.s.reach.cards[2]!, caption: props.s.visual.web.caption },
];

defineExpose({
  ...((__BUILD_MODE_IS_TEST__ && {
    TEST_ONLY: {
      // Export internal state and logic used only for testing here. Do not reference these in production logic.
    },
  }) || {}),
});
</script>

<template>
  <article class="prose" data-testid="docs-app-permissions">
    <h1>{{ s.title }}</h1>
    <p v-for="paragraph in s.intro" :key="paragraph" class="lead">{{ paragraph }}</p>

    <section>
      <h2>{{ s.reach.title }}</h2>
      <p>{{ s.reach.intro }}</p>
      <section v-for="entry in accessCases" :key="entry.mode" class="access-example" :data-testid="`access-example-${entry.mode}`">
        <h3>{{ entry.card.title }}</h3>
        <p class="access-scope">{{ entry.card.scope }}</p>
        <p>{{ entry.card.body }}</p>
        <figure class="guide-figure">
          <AppPermissionsDiagram :mode="entry.mode" :copy="s.visual" />
          <figcaption>{{ entry.caption }}</figcaption>
        </figure>
        <div class="source-links">
          <ExternalLink v-for="source in entry.card.sources" :key="source.href" :href="source.href" :locale="locale">{{ source.label }}</ExternalLink>
        </div>
      </section>
      <p class="comparison-note">{{ s.reach.caption }} <ExternalLink :href="s.reach.sandboxSource.href" :locale="locale">{{ s.reach.sandboxSource.label }}</ExternalLink></p>
    </section>

    <section>
      <h2>{{ s.send.title }}</h2>
      <p>{{ s.send.first }}</p>
      <figure class="guide-figure">
        <AppPermissionsDiagram mode="send" :copy="s.visual" />
        <figcaption>{{ s.visual.send.caption }}</figcaption>
      </figure>
      <p>{{ s.send.second }}</p>
      <div class="source-links">
        <ExternalLink v-for="source in s.send.sources" :key="source.href" :href="source.href" :locale="locale">{{ source.label }}</ExternalLink>
      </div>
      <p class="local-only-link"><DocsLink :locale="locale" page="csp-editions">{{ s.send.localOnlyLink }} <span aria-hidden="true">→</span></DocsLink></p>
    </section>

    <section>
      <h2>{{ s.noPrompt.title }}</h2>
      <p>{{ s.noPrompt.body }}</p>
      <figure class="guide-figure">
        <AppPermissionsDiagram mode="noPrompt" :copy="s.visual" />
        <figcaption>{{ s.visual.noPrompt.caption }}</figcaption>
      </figure>
      <div class="source-links">
        <ExternalLink v-for="source in s.noPrompt.sources" :key="source.href" :href="source.href" :locale="locale">{{ source.label }}</ExternalLink>
      </div>
    </section>

    <section>
      <h2>{{ s.choose.title }}</h2>
      <p>{{ s.choose.body }}</p>
      <p>{{ s.choose.note }}</p>
      <div class="source-links">
        <ExternalLink v-for="source in s.choose.sources" :key="source.href" :href="source.href" :locale="locale">{{ source.label }}</ExternalLink>
      </div>
    </section>

    <RelatedGuide :locale="locale" :eyebrow="common.relatedGuides" :guides="[
      { page: 'browser-boundaries', ...s.related.boundary },
      { page: 'csp-editions', ...s.related.localOnly },
      { page: 'standalone', ...s.related.standalone },
    ]" />
  </article>
</template>

<style scoped>
.source-links { display:flex;flex-wrap:wrap;gap:5px 14px;margin-top:12px;font-size:12px;line-height:1.8; }
.access-example { margin-top:30px; }
.access-example h3 { margin-bottom:5px; }
.access-scope { margin:0 0 12px!important; color:var(--blue)!important; font-size:12px!important; font-weight:750; }
.guide-figure { margin:18px 0 0; }
.guide-figure figcaption { margin-top:10px; color:var(--muted); font-size:12px; line-height:1.8; }
.comparison-note { margin-top:18px; font-size:12px; color:var(--muted); }
.local-only-link { margin-top:16px;font-size:13px; }
</style>
