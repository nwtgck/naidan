<script setup lang="ts">
import { ArrowUpIcon, ChevronDownIcon, FileEditIcon, PlusIcon, Settings2Icon, SquareIcon } from 'lucide-vue-next';

// Presentation only. Each scene owns its input, pointers and explanatory motion.
defineProps<{
  messages: Readonly<typeof import('../../messages/replica-chrome/en').messages>,
  model?: string,
  source?: string,
  reasoning?: string,
  status?: 'idle' | 'ready' | 'generating',
}>();

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <div class="chat-input" :data-status="status ?? 'idle'" data-testid="docs-chat-input" aria-hidden="true">
    <div class="chat-input-text" data-testid="docs-chat-input-text"><slot>{{ messages.chrome_input_placeholder }}</slot></div>
    <span class="chat-input-hide" :title="messages.chrome_hide_input"><ChevronDownIcon :size="14" /></span>
    <div class="chat-input-footer">
      <div class="chat-input-controls">
        <span class="chat-input-control" :title="messages.chrome_attach" data-testid="docs-chat-input-attach"><PlusIcon :size="16" /><slot name="attach" /></span>
        <span class="chat-input-control" :title="messages.chrome_tools" data-testid="docs-chat-input-tools"><Settings2Icon :size="16" /><slot name="tools" /></span>
        <span class="chat-input-control" :title="messages.chrome_advanced_editor" data-testid="docs-chat-input-editor"><FileEditIcon :size="16" /><slot name="editor" /></span>
        <span class="chat-input-model" data-testid="docs-chat-input-model">
          <span class="chat-input-model-name">{{ model || messages.chrome_model }}</span>
          <span v-if="source || reasoning" class="chat-input-model-detail"><span v-if="source" class="chat-input-source" data-testid="docs-chat-input-source">{{ source }}</span><span v-if="reasoning" class="chat-input-reasoning" :title="messages.chrome_reasoning" data-testid="docs-chat-input-reasoning">{{ reasoning }}</span></span>
          <slot name="model" />
        </span>
        <span class="chat-input-send" :title="status === 'generating' ? messages.chrome_stop : messages.chrome_send" data-testid="docs-chat-input-send">
          <slot name="send"><SquareIcon v-if="status === 'generating'" :size="15" class="chat-input-stop" /><ArrowUpIcon v-else :size="16" :stroke-width="2.5" /><kbd class="chat-input-shortcut">{{ status === 'generating' ? 'Esc' : 'Ctrl + Enter' }}</kbd></slot>
        </span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.chat-input {
  position: relative;
  min-width: 0;
  border: 1px solid var(--line-strong);
  border-radius: 14px;
  background: var(--surface-3);
  color: var(--muted);
  box-shadow: 0 6px 18px color-mix(in srgb, var(--text) 8%, transparent);
  container-type: inline-size;
  container-name: docs-chat-input;
  font: var(--chat-input-font-size, 11px)/1.5 ui-sans-serif,system-ui,sans-serif;
}
.chat-input-text {
  min-height: 37px;
  padding: 10px 45px 7px 12px;
  color: var(--subtle);
  overflow-wrap: anywhere;
}
.chat-input-hide {
  position: absolute;
  top: 6px;
  right: 6px;
  display: grid;
  width: var(--chat-input-control-size, 28px);
  height: var(--chat-input-control-size, 28px);
  place-items: center;
}
.chat-input-footer {
  display: flex;
  justify-content: flex-end;
  padding: 3px 6px 6px;
}
.chat-input-controls {
  display: flex;
  min-width: 0;
  max-width: 100%;
  align-items: center;
  gap: 3px;
}
.chat-input-control {
  position: relative;
  display: grid;
  width: var(--chat-input-control-size, 28px);
  height: var(--chat-input-control-size, 28px);
  flex: none;
  place-items: center;
  border-radius: 9px;
}
.chat-input-model {
  position: relative;
  display: flex;
  min-width: 0;
  max-width: 230px;
  min-height: var(--chat-input-control-size, 28px);
  flex-direction: column;
  justify-content: center;
  padding: 2px 7px;
}
.chat-input-model-name {
  overflow: hidden;
  color: var(--text);
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 500;
}
.chat-input-model-detail {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 5px;
  font-size: .85em;
  line-height: 1.4;
}
.chat-input-source {
  overflow: hidden;
  max-width: 100%;
  padding: 0 3px;
  border-radius: 4px;
  background: var(--surface-2);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.chat-input-reasoning {
  white-space: nowrap;
}
.chat-input-send {
  position: relative;
  display: inline-flex;
  min-width: var(--chat-input-control-size, 28px);
  min-height: var(--chat-input-control-size, 28px);
  flex: none;
  align-items: center;
  justify-content: center;
  gap: 5px;
  padding-inline: 5px;
  border-radius: 9px;
  background: var(--surface-2);
  color: var(--subtle);
}
.chat-input[data-status='ready'] .chat-input-send,
.chat-input[data-status='generating'] .chat-input-send {
  background: #2563eb;
  color: white;
}
.chat-input-stop {
  fill: currentColor;
}
.chat-input-shortcut {
  display: none;
  font: inherit;
  white-space: nowrap;
}
@container docs-chat-input (min-width: 40rem) {
  .chat-input-shortcut {
    display: inline;
  }
}
</style>
