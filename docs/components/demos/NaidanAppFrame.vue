<script setup lang="ts">
import logo from '../../assets/naidan.svg';
import { PanelLeftIcon, Settings2Icon, SettingsIcon, FolderIcon, MessageSquareIcon, SearchIcon, SquarePenIcon } from 'lucide-vue-next';

// Deliberately independent of app stores and inference imports. See docs/components/demos/README.md
// for the current app components and tests whose presentation this replica follows.
defineProps<{ title: string; address: string; sidebar: 'visible' | 'hidden'; messages: typeof import('../../messages/replica-chrome/en').messages }>();


defineExpose({
  ...((__BUILD_MODE_IS_TEST__ && {
    TEST_ONLY: {
      // Export internal state and logic used only for testing here. Do not reference these in production logic.
      // ESLint-required for defineExpose.
    },
  }) || {}),
});
</script>

<template>
  <div class="replica" data-testid="replica-chrome">
    <div class="replica-address"><span class="replica-dots"><i /><i /><i /></span><code>{{ address }}</code><span class="replica-security">◇</span></div>
    <div class="replica-body" :class="{ 'with-sidebar': sidebar === 'visible' }">
      <aside v-if="sidebar === 'visible'" class="replica-sidebar">
        <div class="replica-brand"><img :src="logo" alt="" width="21" height="21"><b>Naidan</b></div>
        <div class="replica-new"><SquarePenIcon :size="13" /><span>{{ messages.chrome_new_chat }}</span></div>
        <div class="replica-search"><SearchIcon :size="12" /><span>{{ messages.chrome_search }}</span></div>
        <div class="replica-group"><FolderIcon :size="13" /><span>{{ messages.chrome_chat_group }}</span></div>
        <slot name="chats">
          <div class="replica-chat active"><MessageSquareIcon :size="12" /><span>{{ title }}</span></div>
          <div class="replica-chat"><MessageSquareIcon :size="12" /><span>{{ messages.chrome_other_chat }}</span></div>
        </slot>
        <div class="replica-bottom"><SettingsIcon :size="14" /><span>{{ messages.chrome_settings }}</span></div>
      </aside>
      <div class="replica-main">
        <div class="replica-header"><PanelLeftIcon :size="15" /><strong><slot name="title">{{ title }}</slot></strong><Settings2Icon :size="15" /></div>
        <slot />
      </div>
    </div>
  </div>
</template>

<style scoped>
.replica {
  --app-bg: var(--bg);
  --app-surface: var(--surface-2);
  --app-line: var(--line-strong);
  background: var(--app-bg);
  border: 1px solid var(--line-strong);
  border-radius: 17px;
  overflow: hidden;
  color: var(--text);
  font-family: ui-sans-serif, system-ui, sans-serif;
  text-align: left;
  box-shadow: 0 22px 64px #0003;
  min-width: 0;
}

.replica-address {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 12px 15px;
  background: var(--surface-2);
  border-bottom: 1px solid var(--line);
}

.replica-address code {
  display: block;
  min-width: 0;
  width: 100%;
  overflow-wrap: anywhere;
  white-space: normal;
  background: var(--bg);
  border-radius: 6px;
  padding: 4px 8px;
  color: var(--muted);
  font: 10px/1.6 ui-monospace, monospace;
}

.replica-dots {
  display: flex;
  gap: 5px;
}

.replica-dots i {
  width: 6px;
  height: 6px;
  background: var(--subtle);
  border-radius: 100%;
}

.replica-security {
  color: var(--blue);
}

.replica-body {
  display: grid;
}

.with-sidebar {
  grid-template-columns: 124px minmax(0,1fr);
}

.replica-sidebar {
  display: flex;
  flex-direction: column;
  background: var(--surface);
  border-right: 1px solid var(--line);
  padding: 14px 8px;
  font-size: 10px;
  gap: 7px;
}

.replica-brand {
  display: flex;
  gap: 7px;
  align-items: center;
  padding: 0 4px 14px;
  font-size: 13px;
  letter-spacing: -.035em;
}

.replica-new,.replica-search,.replica-chat,.replica-group,.replica-bottom {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 7px 6px;
}

.replica-new {
  border: 1px solid var(--line-strong);
  border-radius: 7px;
  color: var(--text);
}

.replica-search {
  color: var(--muted);
}

.replica-group {
  margin-top: 12px;
  color: var(--muted);
}

.replica-chat {
  align-items: flex-start;
  color: var(--muted);
}

.replica-chat span,.replica-group span {
  min-width: 0;
  overflow-wrap: anywhere;
}

.replica-chat.active {
  background: color-mix(in srgb,var(--blue) 14%,var(--surface));
  color: var(--blue);
  border-radius: 7px;
}

.replica-bottom {
  margin-top: auto;
  color: var(--muted);
}

.replica-main {
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.replica-header {
  display: flex;
  align-items: center;
  gap: 10px;
  border-bottom: 1px solid var(--line);
  padding: 14px 16px;
  color: var(--muted);
  font-size: 11px;
}

.replica-header strong {
  flex: 1;
  min-width: 0;
  overflow-wrap: anywhere;
  color: var(--text);
  font-weight: 600;
}

.replica-header svg {
  flex-shrink: 0;
}

@media(max-width:600px) {
  .with-sidebar {
    grid-template-columns: 88px minmax(0,1fr);
  }
  .replica-sidebar {
    padding: 11px 4px;
    font-size: 8px;
  }
  .replica-new,.replica-chat,.replica-group {
    padding: 6px 3px;
  }
  .replica-brand {
    font-size: 11px;
    gap: 4px;
  }
  .replica-address {
    gap: 9px;
  }
  .replica-header {
    padding: 12px;
    font-size: 10px;
  }
}
</style>
