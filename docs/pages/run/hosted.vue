<script setup lang="ts">
import ExternalLink from '../../site/ExternalLink.vue';
import RelatedGuide from '../../site/RelatedGuide.vue';
import UiText from '../../site/UiText.vue';
import { docsHref } from '../../site/routes';
import type { DocsLocale } from '../../site/routes';
import type { CommonMessages, HostedGuideMessages } from '../../site/messages';

defineProps<{ s: HostedGuideMessages; locale: DocsLocale; common: CommonMessages }>();

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <article class="prose" data-testid="docs-run-hosted">
    <h1>{{ s.title }}</h1>
    <p class="lead">{{ s.intro }}</p>
    <ExternalLink href="https://github.com/nwtgck/naidan/releases/latest" :locale="locale">{{ s.releaseLink }}</ExternalLink>

    <h2>{{ s.stepsTitle }}</h2>
    <ol class="guide-steps">
      <li>
        <h3>{{ s.download.title }}</h3>
        <p>{{ s.download.before }} <code>naidan-hosted-v0.24.1.zip</code> {{ s.download.after }}</p>
        <p>{{ s.download.folderBefore }} <code>naidan-hosted-0.24.1/</code> {{ s.download.folderAfter }}</p>
      </li>
      <li>
        <h3>{{ s.serve.title }}</h3>
        <p>{{ s.serve.before }}</p>
        <pre data-testid="hosted-python-command"><code>python3 -m http.server 8000 --bind 127.0.0.1</code></pre>
        <p>{{ s.serve.after }}</p>
      </li>
      <li>
        <h3>{{ s.open.title }}</h3>
        <p>{{ s.open.before }} <code>http://127.0.0.1:8000/</code> {{ s.open.after }}</p>
      </li>
    </ol>

    <section class="hosted-other-server">
      <h2>{{ s.otherServer.title }}</h2>
      <p>{{ s.otherServer.body }}</p>
    </section>

    <section>
      <h2>{{ s.model.title }}</h2>
      <p>{{ s.model.body }}</p>
      <figure class="guide-figure hosted-flow" data-docs-animation="hosted-static-flow">
        <div class="flow-track" aria-hidden="true">
          <span class="flow-node">{{ s.flow.zip }}</span>
          <span class="flow-arrow">→</span>
          <span class="flow-node">{{ s.flow.server }}</span>
          <span class="flow-arrow">→</span>
          <span class="flow-node flow-browser">{{ s.flow.browser }}</span>
        </div>
        <div class="flow-model" aria-hidden="true"><span>{{ s.flow.model }}</span></div>
        <figcaption class="caption">{{ s.flow.caption }}</figcaption>
      </figure>
      <p>{{ s.model.nextBefore }}<a :href="docsHref({ locale, page: 'models/in-browser' })">{{ s.model.browserGuide }}</a>{{ s.model.nextMiddle }}<a :href="docsHref({ locale, page: 'models/llama-cpp-browser' })">{{ s.model.ggufGuide }}</a>{{ s.model.nextOr }}<a :href="docsHref({ locale, page: 'models/local-engines' })">{{ s.model.engineGuide }}</a>{{ s.model.nextAfter }}</p>
    </section>

    <section>
      <h2>{{ s.origin.title }}</h2>
      <p>{{ s.origin.body }}</p>
    </section>

    <section>
      <h2>{{ s.update.title }}</h2>
      <p>{{ s.update.files }}</p>
      <p><UiText :text="s.update.storage" /></p>
      <p>{{ s.update.pwaBefore }}<a :href="docsHref({ locale, page: 'run/offline' })">{{ s.update.pwaGuide }}</a>{{ s.update.pwaAfter }}</p>
    </section>

    <RelatedGuide :locale="locale" :eyebrow="common.relatedGuides" :guides="[
      { page: 'run/offline', title: s.related.offline, description: s.related.offlineDescription },
      { page: 'run/standalone', title: s.related.standalone, description: s.related.standaloneDescription },
      { page: 'data/backup', title: s.related.backup, description: s.related.backupDescription },
    ]" />
  </article>
</template>

<style scoped>
.hosted-other-server { margin-top:36px; }
.hosted-flow { margin:22px 0 20px; }
.flow-track { display:flex;align-items:center;gap:9px;padding:18px;border:1px solid var(--line-strong);border-radius:15px;background:var(--surface); }
.flow-node { flex:1;min-width:0;padding:15px 10px;border:1px solid var(--line-strong);border-radius:10px;background:var(--surface-2);font-size:12px;line-height:1.6;font-weight:700;text-align:center;overflow-wrap:anywhere; }
.flow-browser { border-color:var(--blue);animation:hosted-flow-focus 4s ease-in-out infinite; }
.flow-arrow { flex:none;color:var(--blue);font-weight:800; }
.flow-model { display:flex;justify-content:flex-end;padding:7px 18px 0; }
.flow-model span { width:calc((100% - 36px) / 3);min-width:0;padding:10px;border:1px dashed var(--blue);border-radius:10px;color:var(--muted);font-size:12px;line-height:1.5;text-align:center;overflow-wrap:anywhere; }
.flow-model::before { content:'↕';align-self:center;margin-right:9px;color:var(--blue);font-weight:800; }
@keyframes hosted-flow-focus { 50% { box-shadow:0 0 0 4px color-mix(in srgb,var(--blue) 13%,transparent); } }
@media(max-width:560px) { .flow-track { flex-direction:column;align-items:stretch; } .flow-arrow { align-self:center;transform:rotate(90deg); } .flow-model { justify-content:center; } .flow-model span { width:100%; } }
@media(prefers-reduced-motion:reduce) { .flow-browser { animation:none; } }
</style>
