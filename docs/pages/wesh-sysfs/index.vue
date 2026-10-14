<script setup lang="ts">
import AppEntryLink from '../../site/AppEntryLink.vue';
import RelatedGuide from '../../site/RelatedGuide.vue';
import UiText from '../../site/UiText.vue';
import type { DocsLocale } from '../../site/routes';
import type { CommonMessages, WeshSysfsMessages } from '../../site/messages';

defineProps<{ s: WeshSysfsMessages; locale: DocsLocale; common: CommonMessages }>();

const chatCommands = `\
ls /sys/fs/naidan
cat /sys/fs/naidan/current-chat/metadata.md
ls /sys/fs/naidan/current-chat/content-md`;
const binaryCommands = 'ls /sys/fs/naidan/binary-objects/by-id';

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <article class="prose" data-testid="docs-wesh-sysfs">
    <h1>{{ s.title }}</h1>
    <p class="lead">{{ s.intro }} <code>/sys/fs/naidan</code>{{ s.introAfter }}</p>
    <p class="app-entry-intro">{{ s.launch.before }}<AppEntryLink :destination="{ kind: 'screen', screen: 'home' }" :locale="locale" display="path" />{{ s.launch.after }}</p>

    <section aria-labelledby="sysfs-purpose">
      <h2 id="sysfs-purpose">{{ s.purpose.title }}</h2>
      <p>{{ s.purpose.body }}</p>
    </section>

    <section aria-labelledby="sysfs-filesystem">
      <h2 id="sysfs-filesystem">{{ s.filesystem.title }}</h2>
      <p>{{ s.filesystem.body }}</p>
    </section>

    <section aria-labelledby="sysfs-example" data-testid="docs-wesh-sysfs-example">
      <h2 id="sysfs-example">{{ s.example.title }}</h2>
      <p>{{ s.example.request }}</p>
      <p><UiText :text="s.example.scope" /></p>
      <pre><code>{{ s.example.command }}</code></pre>
      <p>{{ s.example.resultBefore }}<code>branches/leaves-md/</code>{{ s.example.resultBetween }}<code>current-chat/content-md/</code>{{ s.example.resultAfter }}</p>
    </section>

    <section aria-labelledby="sysfs-scope">
      <h2 id="sysfs-scope">{{ s.scope.title }}</h2>
      <p>{{ s.scope.intro }}</p>
      <div class="scope-scroll">
        <table class="scope-table" data-testid="docs-wesh-sysfs-scope">
          <thead><tr><th scope="col">{{ s.scope.columns.choice }}</th><th scope="col">{{ s.scope.columns.chats }}</th><th scope="col">{{ s.scope.columns.saved }}</th></tr></thead>
          <tbody>
            <tr v-for="row in s.scope.rows" :key="row.choice">
              <th scope="row"><UiText :text="row.choice" /></th>
              <td>{{ row.chats }}</td>
              <td>{{ row.saved }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p><UiText :text="s.scope.detail" /></p>
    </section>

    <section aria-labelledby="sysfs-start">
      <h2 id="sysfs-start">{{ s.start.title }}</h2>
      <p><UiText :text="s.start.settingsBefore" /><code>/sys/fs/naidan</code><UiText :text="s.start.settingsAfter" /></p>
      <p><UiText :text="s.start.terminal" /></p>
      <p class="session-note"><UiText :text="s.start.session" /></p>
    </section>

    <section aria-labelledby="sysfs-paths">
      <h2 id="sysfs-paths">{{ s.paths.title }}</h2>
      <p>{{ s.paths.intro }}</p>
      <dl class="path-list" data-testid="docs-wesh-sysfs-paths">
        <div v-for="row in s.paths.rows" :key="row.path">
          <dt><code>{{ row.path }}</code></dt>
          <dd>{{ row.detail }}</dd>
        </div>
      </dl>
    </section>

    <section aria-labelledby="sysfs-read">
      <h2 id="sysfs-read">{{ s.read.title }}</h2>
      <p>{{ s.read.chat }}</p>
      <pre lang="en"><code>{{ chatCommands }}</code></pre>
      <p>{{ s.read.binary }}</p>
      <pre lang="en"><code>{{ binaryCommands }}</code></pre>
      <p>{{ s.read.binaryPath }}</p>
      <p class="path-example"><code>/sys/fs/naidan/binary-objects/by-id/{id}/metadata.md</code><br><code>/sys/fs/naidan/binary-objects/by-id/{id}/data</code></p>
    </section>

    <section aria-labelledby="sysfs-connections">
      <h2 id="sysfs-connections">{{ s.connections.title }}</h2>
      <p><UiText :text="s.connections.shell" /></p>
      <p><UiText :text="s.connections.wikipedia" /></p>
      <p>{{ s.connections.folders }}</p>
      <p><UiText :text="s.connections.explorer" /></p>
    </section>

    <RelatedGuide :locale="locale" :eyebrow="common.relatedGuides" :guides="[
      { page: 'tool-browser-shell', ...s.related.shell },
      { page: 'tool-wikipedia', ...s.related.wikipedia },
      { page: 'files-and-folders-settings', ...s.related.files },
      { page: 'file-explorer', ...s.related.explorer },
    ]" />
  </article>
</template>

<style scoped>
.scope-scroll { overflow-x: auto; margin-block: 18px; }
.scope-table { width: 100%; min-width: 560px; border-collapse: collapse; line-height: 1.6; }
.scope-table th, .scope-table td { padding: 11px 13px; border: 1px solid var(--line); text-align: left; vertical-align: top; }
.scope-table thead th { background: var(--surface-2); font-size: .84em; }
.scope-table tbody th { width: 28%; min-width: 138px; font-weight: 750; }
.scope-table tbody td { width: 36%; }
.session-note { padding: 14px 18px; border-left: 3px solid var(--blue); border-radius: 0 10px 10px 0; background: var(--surface); }
.path-list { display: grid; gap: 10px; margin-block: 20px; }
.path-list > div { display: grid; grid-template-columns: minmax(180px, 32%) minmax(0, 1fr); gap: 12px; padding: 13px 15px; border: 1px solid var(--line); border-radius: 10px; }
.path-list dt { min-width: 0; font-weight: 750; overflow-wrap: anywhere; }
.path-list dd { margin: 0; min-width: 0; }
.path-example { padding: 10px 13px; border: 1px solid var(--line); border-radius: 9px; overflow-wrap: anywhere; }
@media (max-width: 640px) { .path-list > div { grid-template-columns: 1fr; gap: 4px; } }
</style>
