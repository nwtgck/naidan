<script setup lang="ts">
import ExternalLink from '../../site/ExternalLink.vue';
import RelatedGuide from '../../site/RelatedGuide.vue';
import { docsHref, type DocsLocale } from '../../site/routes';
import type { AppPermissionsMessages, CommonMessages } from '../../site/messages';

defineProps<{ s: AppPermissionsMessages; locale: DocsLocale; common: CommonMessages }>();

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
      <h2>{{ s.noPrompt.title }}</h2>
      <p>{{ s.noPrompt.body }}</p>
      <div class="source-links">
        <ExternalLink v-for="source in s.noPrompt.sources" :key="source.href" :href="source.href" :locale="locale">{{ source.label }}</ExternalLink>
      </div>
    </section>

    <section>
      <h2>{{ s.reach.title }}</h2>
      <p>{{ s.reach.intro }}</p>
      <figure class="reach-comparison" data-testid="app-reach-comparison">
        <div class="reach-cards">
          <section v-for="card in s.reach.cards" :key="card.title" class="reach-card">
            <h3>{{ card.title }}</h3>
            <p class="scope">{{ card.scope }}</p>
            <p>{{ card.body }}</p>
            <div class="source-links">
              <ExternalLink v-for="source in card.sources" :key="source.href" :href="source.href" :locale="locale">{{ source.label }}</ExternalLink>
            </div>
          </section>
        </div>
        <figcaption>{{ s.reach.caption }} <ExternalLink :href="s.reach.sandboxSource.href" :locale="locale">{{ s.reach.sandboxSource.label }}</ExternalLink></figcaption>
      </figure>
    </section>

    <section>
      <h2>{{ s.send.title }}</h2>
      <p>{{ s.send.first }}</p>
      <p>{{ s.send.second }}</p>
      <div class="source-links">
        <ExternalLink v-for="source in s.send.sources" :key="source.href" :href="source.href" :locale="locale">{{ source.label }}</ExternalLink>
      </div>
      <p class="local-only-link"><a :href="docsHref({ locale, page: 'work/local-only' })">{{ s.send.localOnlyLink }} <span aria-hidden="true">→</span></a></p>
    </section>

    <section>
      <h2>{{ s.choose.title }}</h2>
      <p>{{ s.choose.body }}</p>
      <p>{{ s.choose.note }}</p>
    </section>

    <RelatedGuide :locale="locale" :eyebrow="common.relatedGuides" :guides="[
      { page: 'work/boundary', ...s.related.boundary },
      { page: 'work/local-only', ...s.related.localOnly },
      { page: 'run/standalone', ...s.related.standalone },
    ]" />
  </article>
</template>

<style scoped>
.source-links { display:flex;flex-wrap:wrap;gap:5px 14px;margin-top:12px;font-size:12px;line-height:1.8; }
.reach-comparison { margin:22px 0 0; }
.reach-cards { display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px; }
.reach-card { display:flex;flex-direction:column;min-width:0;padding:20px;border:1px solid var(--line-strong);border-radius:14px;background:var(--surface); }
.reach-card h3 { margin:0 0 4px;font-size:17px;line-height:1.5; }
.reach-card .scope { margin:0 0 12px;color:var(--blue);font-size:12px;font-weight:750;line-height:1.5; }
.reach-card > p:not(.scope) { margin:0;flex:1;font-size:13px;line-height:1.8; }
.reach-card .source-links { margin-top:16px;padding-top:12px;border-top:1px solid var(--line); }
.reach-comparison figcaption { margin-top:12px;color:var(--muted);font-size:12px;line-height:1.8; }
.local-only-link { margin-top:16px;font-size:13px; }
@media(max-width:720px) { .reach-cards { grid-template-columns:1fr; } .reach-card { padding:18px; } }
</style>
