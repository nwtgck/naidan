<script setup lang="ts">
import ExternalLink from '../../components/ExternalLink.vue';
import RelatedGuide from '../../components/RelatedGuide.vue';
import RenderText from '../../components/RenderText';
import type { DocsLocale } from '../../navigation/routes';
import type { CommonMessages, HostedGuideMessages } from '../../messages/types';

defineProps<{ s: HostedGuideMessages; locale: DocsLocale; common: CommonMessages }>();

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <article class="prose" data-testid="docs-run-hosted">
    <h1>{{ s.title }}</h1>
    <p class="lead">{{ s.introduction }}</p>
    <ExternalLink href="https://github.com/nwtgck/naidan/releases/latest" :locale="locale">{{ s.latest_release_link }}</ExternalLink>

    <h2>{{ s.open_extracted_zip_title }}</h2>
    <ol class="guide-steps">
      <li>
        <h3>{{ s.download_hosted_zip_title }}</h3>
        <p><RenderText :node="s.hosted_archive_example()" /></p>
        <p><RenderText :node="s.extracted_folder_example()" /></p>
      </li>
      <li>
        <h3>{{ s.serve_extracted_folder_title }}</h3>
        <p>{{ s.start_python_server_instructions }}</p>
        <pre data-testid="hosted-python-command"><code>python3 -m http.server 8000 --bind 127.0.0.1</code></pre>
        <p><RenderText :node="s.windows_python_fallback()" /></p>
        <p>{{ s.keep_server_running_instructions }}</p>
      </li>
      <li>
        <h3>{{ s.open_local_address_title }}</h3>
        <p><RenderText :node="s.local_address_example()" /></p>
      </li>
    </ol>

    <section class="hosted-other-server">
      <h2>{{ s.other_static_server_title }}</h2>
      <p>{{ s.other_static_server_explanation }}</p>
    </section>

    <section>
      <h2>{{ s.choose_model_title }}</h2>
      <p>{{ s.model_setup_explanation }}</p>
      <figure class="guide-figure hosted-flow" data-docs-animation="hosted-static-flow">
        <div class="flow-track" aria-hidden="true">
          <span class="flow-node">{{ s.extracted_hosted_zip }}</span>
          <span class="flow-arrow">→</span>
          <span class="flow-node">{{ s.static_http_server }}</span>
          <span class="flow-arrow">→</span>
          <span class="flow-node flow-browser">{{ s.naidan_in_browser }}</span>
        </div>
        <div class="flow-model" aria-hidden="true"><span>{{ s.model_or_inference_engine }}</span></div>
        <figcaption class="caption">{{ s.hosted_file_flow_caption }}</figcaption>
      </figure>
      <p><RenderText :node="s.model_setup_guides({ locale })" /></p>
    </section>

    <section>
      <h2>{{ s.why_hosted_zip_title }}</h2>
      <p>{{ s.http_origin_explanation }}</p>
    </section>

    <section>
      <h2>{{ s.update_same_address_title }}</h2>
      <p>{{ s.update_served_files_instructions }}</p>
      <p><RenderText :node="s.origin_storage_notice()" /></p>
      <p><RenderText :node="s.pwa_update_guidance({ locale })" /></p>
    </section>

    <RelatedGuide :locale="locale" :eyebrow="common.related_guides" :guides="[
      { page: 'pwa', title: s.offline_pwa_guide_title, description: s.offline_pwa_guide_description },
      { page: 'standalone', title: s.standalone_guide_title, description: s.standalone_guide_description },
      { page: 'data-backup', title: s.backup_guide_title, description: s.backup_guide_description },
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
