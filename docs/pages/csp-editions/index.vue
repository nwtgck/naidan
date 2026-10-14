<script setup lang="ts">
import { computed } from 'vue';
import ExternalLink from '../../components/ExternalLink.vue';
import RelatedGuide from '../../components/RelatedGuide.vue';
import RenderText from '../../components/RenderText';
import ConnectionPolicyDiagram from '../../components/demos/ConnectionPolicyDiagram.vue';
import type { DocsLocale } from '../../navigation/routes';
import type { CommonMessages, LocalOnlyMessages } from '../../messages/types';

const props = defineProps<{ s: LocalOnlyMessages; locale: DocsLocale; common: CommonMessages }>();
const versions = computed(() => [
  { title: props.s.versions_local_only_title, body: props.s.versions_local_only_body, link: props.s.versions_local_only_link, url: 'https://naidan-local-only.pages.dev' },
  { title: props.s.versions_curated_title, body: props.s.versions_curated_body, link: props.s.versions_curated_link, url: 'https://naidan-curated.pages.dev' },
  { title: props.s.versions_standard_title, body: props.s.versions_standard_body, link: props.s.versions_standard_link, url: 'https://naidan.pages.dev' },
]);
const allowed = computed(() => [
  { address: "'self'", meaning: props.s.own_origin_meaning },
  { address: "http://localhost:*", meaning: props.s.localhost_meaning },
  { address: "http://127.0.0.1:*", meaning: props.s.loopback_meaning },
]);
const checkSteps = computed(() => [
  { title: props.s.read_received_policy_title, body: props.s.read_received_policy_instructions },
  { title: props.s.inspect_local_connection_title, body: props.s.inspect_local_connection_instructions },
  { title: props.s.diagnose_blocked_request_title, body: props.s.diagnose_blocked_request_instructions },
]);

defineExpose({
  ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}),
});
</script>

<template>
  <article class="prose" data-testid="docs-local-only">
    <h1>{{ s.title }}</h1>
    <p class="lead">{{ s.introduction }}</p>

    <section>
      <h2>{{ s.choose_hosted_version_title }}</h2>
      <div class="version-grid">
        <div v-for="version in versions" :key="version.url" class="panel version-card">
          <h3>{{ version.title }}</h3>
          <p>{{ version.body }}</p>
          <code class="version-url">{{ version.url }}</code>
          <ExternalLink :href="version.url" :locale="locale">{{ version.link }}</ExternalLink>
        </div>
      </div>
      <p class="switching-note"><RenderText :node="s.switching_editions_and_backup({ locale })" /></p>
      <figure class="policy-figure"><ConnectionPolicyDiagram :messages="s" /><figcaption>{{ s.connection_policy_caption }}</figcaption></figure>
      <p><RenderText :node="s.deployment_policy_source({ locale })" /></p>
    </section>

    <section>
      <h2>{{ s.connect_local_server_title }}</h2>
      <p>{{ s.connect_local_server_introduction }}</p>
      <dl class="allowed-destinations">
        <div v-for="item in allowed" :key="item.address">
          <dt><code>{{ item.address }}</code></dt>
          <dd>{{ item.meaning }}</dd>
        </div>
      </dl>
      <p><RenderText :node="s.local_server_conditions({ locale })" /></p>
    </section>

    <section>
      <h2>{{ s.connection_policy_scope_title }}</h2>
      <p>{{ s.connection_policy_scope }}</p>
      <p>{{ s.outside_connection_policy_scope }}</p>
    </section>

    <section>
      <h2>{{ s.inspect_policy_and_traffic_title }}</h2>
      <ol class="guide-steps">
        <li v-for="step in checkSteps" :key="step.title"><h3>{{ step.title }}</h3><p><RenderText :node="step.body()" /></p></li>
      </ol>
      <p class="check-note"><RenderText :node="s.network_log_limitations()" /></p>
    </section>

    <RelatedGuide :locale="locale" :eyebrow="common.related_guides" :guides="[{ page: 'local-ai-servers', title: s.local_server_guide_title, description: s.local_server_guide_description }]" />
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
