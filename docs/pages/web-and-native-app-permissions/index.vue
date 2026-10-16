<script setup lang="ts">
import { computed } from 'vue';
import ExternalLink from '../../components/ExternalLink.vue';
import RenderText from '../../components/RenderText';
import RelatedGuide from '../../components/RelatedGuide.vue';
import AppPermissionsDiagram from '../../components/demos/AppPermissionsDiagram.vue';
import type { DocsLocale } from '../../navigation/routes';
import type { AppPermissionsMessages, CommonMessages } from '../../messages/types';

const props = defineProps<{ s: AppPermissionsMessages; locale: DocsLocale; common: CommonMessages }>();
const content = computed(() => {
  const s = props.s;
  return {
    accessCases: [
      { mode: 'desktop' as const, card: { title: s.desktop_access_title, scope: s.desktop_access_scope, body: s.desktop_access_explanation, sources: [{ label: s.source_windows_access_tokens, href: "https://learn.microsoft.com/en-us/windows/win32/secauthz/access-tokens" }, { label: s.source_windows_process_enumeration, href: "https://learn.microsoft.com/en-us/windows/win32/procthread/process-enumeration" }, { label: s.source_windows_process_entry, href: "https://learn.microsoft.com/en-us/windows/win32/api/tlhelp32/ns-tlhelp32-processentry32w" }, { label: s.source_windows_temporary_paths, href: "https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-gettemppath2a" }, { label: s.source_windows_file_rights, href: "https://learn.microsoft.com/en-us/windows/win32/fileio/file-security-and-access-rights" }, { label: s.source_windows_app_permissions, href: "https://support.microsoft.com/en-us/windows/apps/app-permissions" }] }, caption: s.desktop_access_caption },
      { mode: 'mobile' as const, card: { title: s.mobile_access_title, scope: s.mobile_access_scope, body: s.mobile_access_explanation, sources: [{ label: s.source_android_sandbox, href: "https://source.android.com/docs/security/app-sandbox" }, { label: s.source_ios_sandbox, href: "https://support.apple.com/guide/security/sec15bfe098e/web" }, { label: s.source_android_sensor_limits, href: "https://developer.android.com/develop/sensors-and-location/sensors/sensors_overview" }, { label: s.source_android_sensor_sampling, href: "https://developer.android.com/reference/android/Manifest.permission#HIGH_SAMPLING_RATE_SENSORS" }] }, caption: s.mobile_access_caption },
      { mode: 'web' as const, card: { title: s.web_access_title, scope: s.web_access_scope, body: s.web_access_explanation, sources: [{ label: s.source_html_file_selection, href: "https://html.spec.whatwg.org/multipage/input.html#file-upload-state-(type=file)" }, { label: s.source_file_system_api, href: "https://developer.mozilla.org/en-US/docs/Web/API/File_System_API" }] }, caption: s.web_access_caption },
    ],
    sendSources: [{ label: s.source_fetch_api, href: "https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API" }, { label: s.source_same_origin_policy, href: "https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Same-origin_policy" }, { label: s.source_raw_sockets, href: "https://developer.chrome.com/docs/iwa/direct-sockets" }, { label: s.source_local_network, href: "https://developer.apple.com/documentation/technotes/tn3179-understanding-local-network-privacy" }, { label: s.source_csp_connection, href: "https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/connect-src" }],
    noPromptSources: [{ label: s.source_android_manifest_permissions, href: "https://developer.android.com/reference/android/Manifest.permission" }, { label: s.source_android_permission_grants, href: "https://developer.android.com/guide/topics/permissions/overview" }],
    chooseSources: [{ label: s.source_chromium_site_isolation, href: "https://www.chromium.org/Home/chromium-security/site-isolation/" }],
  };
});

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
    <p v-for="paragraph in s.introduction_paragraphs()" :key="paragraph" class="lead">{{ paragraph }}</p>

    <section>
      <h2>{{ s.device_access_title }}</h2>
      <p>{{ s.device_access_introduction }}</p>
      <section v-for="entry in content.accessCases" :key="entry.mode" class="access-example" :data-testid="`access-example-${entry.mode}`">
        <h3>{{ entry.card.title }}</h3>
        <p class="access-scope">{{ entry.card.scope }}</p>
        <p>{{ entry.card.body }}</p>
        <figure class="guide-figure">
          <AppPermissionsDiagram :mode="entry.mode" :messages="s" />
          <figcaption>{{ entry.caption }}</figcaption>
        </figure>
        <div class="source-links">
          <ExternalLink v-for="source in entry.card.sources" :key="source.href" :href="source.href" :locale="locale">{{ source.label }}</ExternalLink>
        </div>
      </section>
      <p class="comparison-note"><RenderText :node="s.desktop_sandbox_comparison({ locale })" /></p>
    </section>

    <section>
      <h2>{{ s.sending_information_title }}</h2>
      <p>{{ s.sending_information_explanation }}</p>
      <figure class="guide-figure">
        <AppPermissionsDiagram mode="send" :messages="s" />
        <figcaption>{{ s.sending_paths_caption }}</figcaption>
      </figure>
      <p>{{ s.browser_network_routes_explanation }}</p>
      <div class="source-links">
        <ExternalLink v-for="source in content.sendSources" :key="source.href" :href="source.href" :locale="locale">{{ source.label }}</ExternalLink>
      </div>
      <p class="local-only-link"><RenderText :node="s.local_only_connection_guide({ locale })" /></p>
    </section>

    <section>
      <h2>{{ s.permission_prompt_title }}</h2>
      <p>{{ s.permission_prompt_explanation }}</p>
      <figure class="guide-figure">
        <AppPermissionsDiagram mode="noPrompt" :messages="s" />
        <figcaption>{{ s.permission_paths_caption }}</figcaption>
      </figure>
      <div class="source-links">
        <ExternalLink v-for="source in content.noPromptSources" :key="source.href" :href="source.href" :locale="locale">{{ source.label }}</ExternalLink>
      </div>
    </section>

    <section>
      <h2>{{ s.choosing_app_form_title }}</h2>
      <p>{{ s.choosing_app_form_explanation }}</p>
      <p>{{ s.capability_comparison_note }}</p>
      <div class="source-links">
        <ExternalLink v-for="source in content.chooseSources" :key="source.href" :href="source.href" :locale="locale">{{ source.label }}</ExternalLink>
      </div>
    </section>

    <RelatedGuide :locale="locale" :eyebrow="common.related_guides" :guides="[
      { page: 'browser-boundaries', title: s.browser_boundary_guide_title, description: s.browser_boundary_guide_description },
      { page: 'csp-editions', title: s.local_only_guide_title, description: s.local_only_guide_description },
      { page: 'standalone', title: s.standalone_guide_title, description: s.standalone_guide_description },
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
