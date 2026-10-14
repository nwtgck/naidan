<script setup lang="ts">
import RelatedGuide from '../../components/RelatedGuide.vue';
import RenderText from '../../components/RenderText';
import type { DocsLocale } from '../../navigation/routes';
import type { CommonMessages, WeshSysfsMessages } from '../../messages/types';

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
    <p class="lead"><RenderText :node="s.intro()" /></p>
    <p class="app-entry-intro"><RenderText :node="s.open_sysfs_chat({ locale, destination: { kind: 'screen', screen: 'home' } })" /></p>

    <section aria-labelledby="sysfs-purpose">
      <h2 id="sysfs-purpose">{{ s.past_decisions_title }}</h2>
      <p>{{ s.past_decisions_body }}</p>
    </section>

    <section aria-labelledby="sysfs-filesystem">
      <h2 id="sysfs-filesystem">{{ s.history_as_filesystem_title }}</h2>
      <p>{{ s.history_as_filesystem_body }}</p>
    </section>

    <section aria-labelledby="sysfs-example" data-testid="docs-wesh-sysfs-example">
      <h2 id="sysfs-example">{{ s.search_history_example_title }}</h2>
      <p>{{ s.search_history_example_request }}</p>
      <p><RenderText :node="s.search_history_example_scope()" /></p>
      <pre><code>{{ s.search_history_command }}</code></pre>
      <p><RenderText :node="s.search_result_explanation()" /></p>
    </section>

    <section aria-labelledby="sysfs-scope">
      <h2 id="sysfs-scope">{{ s.conversation_visibility_title }}</h2>
      <p><RenderText :node="s.conversation_visibility_intro()" /></p>
      <div class="scope-scroll">
        <table class="scope-table" data-testid="docs-wesh-sysfs-scope">
          <thead><tr><th scope="col">{{ s.visibility_choice_column }}</th><th scope="col">{{ s.chat_data_column }}</th><th scope="col">{{ s.saved_objects_column }}</th></tr></thead>
          <tbody>
            <tr v-for="(row, index) in [{ choice: s.mount_off_choice(), chats: s.mount_off_chats, saved: s.mount_off_saved_objects }, { choice: s.current_chat_choice(), chats: s.current_chat_scope, saved: s.current_chat_saved_objects }, { choice: s.chat_group_choice(), chats: s.chat_group_scope, saved: s.chat_group_saved_objects }, { choice: s.all_chats_choice(), chats: s.all_chats_scope, saved: s.all_chats_saved_objects }]" :key="index">
              <th scope="row"><RenderText :node="row.choice" /></th>
              <td>{{ row.chats }}</td>
              <td>{{ row.saved }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p><RenderText :node="s.conversation_visibility_detail()" /></p>
    </section>

    <section aria-labelledby="sysfs-start">
      <h2 id="sysfs-start">{{ s.enable_sysfs_title }}</h2>
      <p><RenderText :node="s.enable_sysfs_settings()" /></p>
      <p><RenderText :node="s.open_wesh_terminal()" /></p>
      <p class="session-note"><RenderText :node="s.terminal_session_scope()" /></p>
    </section>

    <section aria-labelledby="sysfs-paths">
      <h2 id="sysfs-paths">{{ s.sysfs_paths_title }}</h2>
      <p>{{ s.sysfs_paths_intro }}</p>
      <dl class="path-list" data-testid="docs-wesh-sysfs-paths">
        <div v-for="row in [{ path: s.current_chat_path, detail: s.current_chat_path_detail }, { path: s.chats_path, detail: s.chats_path_detail }, { path: s.current_chat_group_path, detail: s.current_chat_group_path_detail() }, { path: s.chat_groups_path, detail: s.chat_groups_path_detail() }, { path: s.hierarchy_path, detail: s.hierarchy_path_detail }, { path: s.binary_objects_path, detail: s.binary_objects_path_detail }, { path: s.version_path, detail: s.version_path_detail }]" :key="row.path">
          <dt><code>{{ row.path }}</code></dt>
          <dd><RenderText v-if="typeof row.detail !== 'string'" :node="row.detail" /><template v-else>{{ row.detail }}</template></dd>
        </div>
      </dl>
    </section>

    <section aria-labelledby="sysfs-read">
      <h2 id="sysfs-read">{{ s.verify_readable_files_title }}</h2>
      <p>{{ s.read_chat_files }}</p>
      <pre lang="en"><code>{{ chatCommands }}</code></pre>
      <p>{{ s.read_saved_objects }}</p>
      <pre lang="en"><code>{{ binaryCommands }}</code></pre>
      <p>{{ s.saved_object_path_patterns }}</p>
      <p class="path-example"><code>/sys/fs/naidan/binary-objects/by-id/{id}/metadata.md</code><br><code>/sys/fs/naidan/binary-objects/by-id/{id}/data</code></p>
    </section>

    <section aria-labelledby="sysfs-connections">
      <h2 id="sysfs-connections">{{ s.other_mounts_title }}</h2>
      <p><RenderText :node="s.shell_mount_relationship()" /></p>
      <p><RenderText :node="s.wikipedia_mount_relationship()" /></p>
      <p>{{ s.device_folders_relationship }}</p>
      <p><RenderText :node="s.file_explorer_relationship()" /></p>
    </section>

    <RelatedGuide :locale="locale" :eyebrow="common.related_guides" :guides="[
      { page: 'tool-browser-shell', title: s.shell_guide_title, description: s.shell_guide_description },
      { page: 'tool-wikipedia', title: s.wikipedia_guide_title, description: s.wikipedia_guide_description },
      { page: 'files-and-folders-settings', title: s.file_settings_guide_title, description: s.file_settings_guide_description },
      { page: 'file-explorer', title: s.file_explorer_guide_title, description: s.file_explorer_guide_description },
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
