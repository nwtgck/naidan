<script setup lang="ts">
import { BrainIcon, CheckCircle2Icon, ChevronDownIcon, FolderIcon, GlobeIcon, MoreHorizontalIcon, MoreVerticalIcon, MousePointer2Icon, PencilIcon, RotateCcwIcon, SaveIcon, SearchIcon, SettingsIcon, XIcon } from 'lucide-vue-next';

defineProps<{
  stage: 'global' | 'group' | 'inheritedChat' | 'chatModel' | 'reset';
  messages: typeof import('../../pages/settings-inheritance/messages/en').messages;
}>();

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <div class="camera-viewport" :class="`stage-${stage}`" :data-docs-animation="`inheritance-${stage}`" :data-testid="`inheritance-step-${stage}`" aria-hidden="true">
    <div class="scene-canvas" data-testid="inheritance-camera-canvas">
      <aside class="app-sidebar">
        <strong class="app-brand">{{ messages.naidan }}</strong>
        <div class="sidebar-tree"><div class="group-item"><FolderIcon :size="17" /><span>{{ messages.translation }}</span><MousePointer2Icon v-if="stage === 'group'" class="pointer entry-pointer" :size="23" /></div><div class="chat-item">{{ messages.article_translation }}</div></div>
        <div class="sidebar-settings"><SettingsIcon :size="17" /><span>{{ messages.settings }}</span><MousePointer2Icon v-if="stage === 'global'" class="pointer entry-pointer" :size="23" /></div>
      </aside>
      <main class="app-workspace">
        <div class="chat-page-header"><h3>{{ messages.article_translation }}</h3><span class="model-trigger" data-testid="inheritance-header-model"><span v-if="stage === 'chatModel'" class="value-stack"><span class="phase-start">{{ messages.group_example_model_id }}</span><span class="phase-end">{{ messages.chat_example_model_id }}</span></span><span v-else-if="stage === 'reset'" class="value-stack"><span class="reset-initial">{{ messages.chat_example_model_id }}</span><span class="reset-cleared">{{ messages.group_example_model_id }}</span><span class="reset-local-model">{{ messages.local_model }}</span><span class="reset-final">{{ messages.group_example_model_id }}</span></span><span v-else>{{ messages.group_example_model_id }}</span><SettingsIcon :size="15" /></span><span class="more-trigger" :title="messages.more_actions"><MoreVerticalIcon :size="20" /><MousePointer2Icon v-if="stage === 'inheritedChat'" class="pointer entry-pointer" :size="23" /></span></div>
        <div v-if="stage === 'inheritedChat'" class="header-menu"><SettingsIcon :size="17" /><span>{{ messages.chat_settings }}</span><MousePointer2Icon class="pointer header-pointer" :size="23" /></div>
        <div class="chat-transcript"><strong>{{ messages.translation }}</strong><p>{{ messages.translate_this_paragraph_into_japanese }}</p><strong>{{ messages.naidan }}</strong><p>{{ messages.i_will_translate_the_paragraph }}</p></div>
      </main>

      <template v-if="stage === 'global'">
        <div class="modal-veil" />
        <div class="settings-modal global-modal" data-testid="inheritance-global-modal">
          <aside class="modal-navigation"><div class="navigation-heading"><SettingsIcon :size="19" /><strong>{{ messages.settings }}</strong></div><div class="navigation-group"><span class="selected"><GlobeIcon :size="16" />{{ messages.connection }}</span><span>{{ messages.tools }}</span><span>{{ messages.profiles }}</span></div><div class="navigation-group"><span>{{ messages.gguf_models }}</span><span>{{ messages.transformers_models }}</span><span>{{ messages.recipes }}</span></div><div class="navigation-group"><span>{{ messages.storage }}</span><span>{{ messages.files }}</span><span>{{ messages.folders }}</span></div><div class="navigation-group"><span>Naidan RPC</span><span>{{ messages.developer }}</span><span>{{ messages.about }}</span></div></aside>
          <div class="global-content"><div class="global-toolbar">{{ messages.copy_setup_url }}<XIcon :size="18" /></div><div class="modal-fields">
            <div class="field"><span class="field-label">{{ messages.connection }}</span><div class="field-value provider-control"><span class="value-stack"><span class="phase-start">{{ messages.openai_compatible }}</span><span class="phase-end">{{ messages.ollama }}</span></span><ChevronDownIcon :size="18" /><MousePointer2Icon class="pointer provider-pointer" :size="23" /><span class="select-menu provider-menu"><span>{{ messages.openai_compatible }}</span><strong>{{ messages.ollama }}</strong></span></div></div>
            <div class="field"><span class="field-label">{{ messages.default_model }}</span><div class="field-value model-control"><span class="value-stack"><span class="phase-start muted">{{ messages.none }}</span><span class="phase-end">{{ messages.global_example_model_id }}</span></span><ChevronDownIcon :size="18" /><MousePointer2Icon class="pointer global-model-pointer" :size="23" /><span class="select-menu model-menu"><span>{{ messages.none }}</span><strong>{{ messages.global_example_model_id }}</strong></span></div></div>
            <div class="reasoning"><span><BrainIcon :size="14" />{{ messages.reasoning }}</span><div class="segments"><strong>{{ messages.reasoning_default }}</strong><span>{{ messages.reasoning_off }}</span><span>{{ messages.reasoning_low }}</span><span>{{ messages.reasoning_medium }}</span><span>{{ messages.reasoning_high }}</span></div></div>
            <div class="connection-details global-details"><div class="field"><span class="field-label">{{ messages.endpoint_url }}</span><div class="field-value mono url-control" data-testid="inheritance-global-url-edit"><span class="value-stack"><span class="phase-start">http://localhost:1234/v1</span><span class="phase-end">http://localhost:11434</span></span><MousePointer2Icon class="pointer url-pointer" :size="23" /></div></div><div class="header-editor"><span class="field-label">{{ messages.http_headers }}</span><span>{{ messages.add_header }}</span></div></div>
          </div><div class="modal-footer"><div class="save-control"><SaveIcon :size="16" /><span class="value-stack"><span class="phase-start">{{ messages.save_changes }}</span><span class="phase-end"><CheckCircle2Icon :size="14" />{{ messages.settings_saved }}</span></span><MousePointer2Icon class="pointer save-pointer" :size="23" /></div></div></div>
        </div>
      </template>

      <template v-else>
        <div v-if="stage !== 'group'" class="modal-veil chat-veil" />
        <div class="scoped-settings" :class="stage === 'group' ? 'group-page' : 'chat-modal'" :data-testid="stage === 'group' ? 'inheritance-group-page' : 'inheritance-chat-modal'">
          <div v-if="stage === 'group'" class="group-heading"><h3>{{ messages.translation }}</h3><PencilIcon :size="17" :title="messages.rename" /><SearchIcon :size="18" :title="messages.search" /><MoreHorizontalIcon :size="20" :title="messages.group_actions" /></div>
          <div v-else class="modal-heading"><strong>{{ messages.chat_specific_overrides }}</strong><XIcon :size="20" /></div>
          <div class="scoped-body">
            <div class="field"><span class="field-label">{{ messages.endpoint_type }}</span><div class="connection-summary" data-testid="inheritance-connection-summary"><div><strong v-if="stage === 'reset'" class="value-stack"><span class="reset-initial">{{ messages.ollama }}</span><span class="reset-local-endpoint">{{ messages.openai_compatible }}</span><span class="reset-final">{{ messages.ollama }}</span></strong><strong v-else>{{ messages.ollama }}</strong><span class="connection-metadata"><span class="source-badge" :class="{ 'endpoint-source': stage === 'group' || stage === 'reset' }">{{ stage === 'group' ? messages.source_global : messages.source_chat_group }}</span><span v-if="stage === 'reset'" class="value-stack mono"><span class="reset-url-initial">http://localhost:11434</span><span class="reset-local-url">http://localhost:1234/v1</span><span class="reset-final">http://localhost:11434</span></span><span v-else class="mono">http://localhost:11434</span></span></div><ChevronDownIcon :size="19" /><MousePointer2Icon v-if="stage !== 'chatModel'" class="pointer summary-pointer" :size="23" /></div></div>
            <div class="field"><span class="field-label">{{ stage === 'group' ? messages.model_id_override : messages.model_override }}</span><div class="field-value model-control"><span><span v-if="stage === 'group' || stage === 'chatModel'" class="value-stack"><span class="phase-start">{{ stage === 'group' ? messages.global_example_model_id : messages.group_example_model_id }}</span><span class="phase-end">{{ stage === 'group' ? messages.group_example_model_id : messages.chat_example_model_id }}</span></span><span v-else-if="stage === 'reset'" class="value-stack"><span class="reset-initial">{{ messages.chat_example_model_id }}</span><span class="reset-cleared">{{ messages.group_example_model_id }}</span><span class="reset-local-model">{{ messages.local_model }}</span><span class="reset-final">{{ messages.group_example_model_id }}</span></span><span v-else>{{ messages.group_example_model_id }}</span><span v-if="stage !== 'reset'" class="source-badge model-source">{{ stage === 'group' ? messages.source_global : messages.source_chat_group }}</span><span v-else class="source-badge reset-model-source">{{ messages.source_chat_group }}</span></span><ChevronDownIcon :size="18" /><MousePointer2Icon v-if="stage !== 'inheritedChat'" class="pointer model-pointer" :size="23" /><span v-if="stage === 'group' || stage === 'chatModel'" class="select-menu model-menu"><span>{{ stage === 'group' ? messages.global_gemma3n_e2b : messages.chat_group_qwen3_4b }}</span><strong>{{ stage === 'group' ? messages.group_example_model_id : messages.chat_example_model_id }}</strong></span><span v-if="stage === 'reset'" class="select-menu reset-model-menu"><span>{{ messages.chat_group_qwen3_4b }}</span><strong>{{ messages.local_model }}</strong></span></div></div>
            <div class="reasoning"><span><BrainIcon :size="14" />{{ messages.reasoning }}<span class="source-badge">{{ stage === 'group' ? messages.source_global : messages.source_chat_group }}</span></span><div class="segments"><strong>{{ messages.reasoning_inherited }}</strong><span>{{ messages.reasoning_off }}</span><span>{{ messages.reasoning_low }}</span><span>{{ messages.reasoning_medium }}</span><span>{{ messages.reasoning_high }}</span></div></div>
            <div v-if="stage !== 'chatModel'" class="connection-details scoped-details" data-testid="inheritance-connection-details">
              <div class="field"><span class="field-label">{{ messages.endpoint_type }}</span><div class="field-value endpoint-control"><span v-if="stage === 'group'" class="value-stack"><span class="phase-start">{{ messages.global_ollama }}</span><span class="phase-end">{{ messages.ollama }}</span></span><span v-else-if="stage === 'reset'" class="value-stack"><span class="reset-initial">{{ messages.chat_group_ollama }}</span><span class="reset-local-endpoint">{{ messages.openai_compatible }}</span><span class="reset-final">{{ messages.chat_group_ollama }}</span></span><span v-else>{{ messages.chat_group_ollama }}</span><ChevronDownIcon :size="18" /><MousePointer2Icon v-if="stage === 'group' || stage === 'reset'" class="pointer endpoint-pointer" :size="23" /><span v-if="stage === 'group'" class="select-menu endpoint-menu"><span>{{ messages.global_ollama }}</span><strong>{{ messages.ollama }}</strong></span><span v-if="stage === 'reset'" class="select-menu reset-endpoint-out-menu"><span>{{ messages.chat_group_ollama }}</span><strong>{{ messages.openai_compatible }}</strong></span><span v-if="stage === 'reset'" class="select-menu reset-endpoint-back-menu"><span>{{ messages.openai_compatible }}</span><strong>{{ messages.chat_group_ollama }}</strong></span></div></div>
              <div class="field"><span class="field-label">{{ messages.endpoint_url }}</span><div class="field-value mono url-control" data-testid="inheritance-effective-url"><span v-if="stage === 'reset'" class="value-stack"><span class="reset-url-initial">http://localhost:11434</span><span class="reset-local-url">http://localhost:1234/v1</span><span class="reset-final">http://localhost:11434</span></span><span v-else>http://localhost:11434</span><MousePointer2Icon v-if="stage === 'reset'" class="pointer reset-url-pointer" :size="23" /></div></div>
              <div class="header-editor"><span class="field-label">{{ messages.http_headers }}</span><span>{{ messages.add_header }}</span></div>
            </div>
            <div class="disclosures"><div v-for="label in [messages.parameters, messages.automatic_title, messages.tools, messages.folders]" :key="label"><span>{{ label }}</span><ChevronDownIcon :size="16" /></div></div>
            <div class="restore-footer"><RotateCcwIcon :size="15" />{{ messages.restore_defaults }}</div>
          </div>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.camera-viewport {
  --focus-x:-125px;
  --focus-y:-230px;
  --summary-y:-110px;
  --focus-scale:1;
  --entry-x:0px;
  --entry-y:-100px;
  --duration:16s;
  position: relative;
  width: 100%;
  max-width: 680px;
  height: 390px;
  margin-inline: auto;
  overflow: hidden;
  container-type: inline-size;
  border: 1px solid var(--line-strong);
  border-radius: 16px;
  background: var(--bg);
  box-shadow: var(--panel-shadow);
  color: var(--text);
}
.scene-canvas {
  position: absolute;
  inset: 0 auto auto 0;
  width: 980px;
  height: 900px;
  transform-origin: 0 0;
  transform: translate(var(--focus-x),var(--focus-y)) scale(var(--focus-scale));
  font: 14px/1.45 ui-sans-serif,system-ui,sans-serif;
  animation: focus-camera var(--duration) ease-in-out infinite;
}
.stage-global .scene-canvas {
  animation-name: global-camera;
}
.stage-global {
  --focus-x:-250px;
  --focus-y:-220px;
  --summary-y:-70px;
  --entry-y:-210px;
}
.stage-group {
  --focus-x:-125px;
  --focus-y:-220px;
  --summary-y:-90px;
  --entry-y:-20px;
}
.stage-inheritedChat {
  --focus-x:-125px;
  --focus-y:-230px;
  --summary-y:-115px;
  --entry-x:-120px;
  --entry-y:-10px;
}
.stage-chatModel {
  --focus-x:-125px;
  --focus-y:-65px;
  --summary-y:-65px;
  --entry-x:-125px;
  --entry-y:-65px;
}
.stage-reset {
  --focus-x:-125px;
  --focus-y:-230px;
  --summary-y:-115px;
  --entry-x:-120px;
  --entry-y:-10px;
  --duration:22s;
}
.app-sidebar {
  position: absolute;
  inset: 0 auto 0 0;
  width: 170px;
  display: flex;
  flex-direction: column;
  padding: 20px 12px;
  border-right: 1px solid var(--line);
  background: var(--surface);
}
.app-brand {
  font-size: 22px;
  letter-spacing: -.05em;
}
.sidebar-tree {
  flex: 1;
  padding-top: 42px;
}
.group-item,.chat-item,.sidebar-settings {
  position: relative;
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 41px;
  padding: 8px 10px;
  border-radius: 10px;
}
.group-item {
  color: var(--blue);
  background: var(--surface-2);
}
.group-item svg,.sidebar-settings svg {
  flex: none;
}
.chat-item {
  margin-left: 25px;
  border-left: 1px solid var(--line);
  color: var(--muted);
  font-size: 12px;
}
.sidebar-settings {
  position: absolute;
  top: 550px;
  left: 12px;
  right: 12px;
  border: 1px solid var(--line);
  color: var(--muted);
}
.app-workspace {
  position: absolute;
  inset: 0 0 0 170px;
  background: var(--bg);
}
.chat-page-header {
  display: flex;
  align-items: center;
  gap: 22px;
  height: 86px;
  padding: 0 35px;
  border-bottom: 1px solid var(--line);
  background: var(--surface);
}
.chat-page-header h3 {
  margin: 0;
  font-size: 20px;
}
.model-trigger {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--muted);
  font-size: 13px;
}
.more-trigger {
  position: relative;
  margin-left: auto;
}
.header-menu {
  position: absolute;
  z-index: 3;
  top: 72px;
  right: 26px;
  display: flex;
  align-items: center;
  gap: 10px;
  width: 225px;
  padding: 12px;
  border: 1px solid var(--line-strong);
  border-radius: 10px;
  background: var(--surface);
  box-shadow: var(--panel-shadow);
  opacity: 0;
  animation: header-menu 16s linear infinite;
}
.chat-transcript {
  width: 490px;
  margin: 70px auto;
  padding: 28px;
  border: 1px solid var(--line);
  border-radius: 20px;
  background: var(--surface);
  color: var(--muted);
}
.chat-transcript p {
  margin: 5px 0 24px;
}
.modal-veil {
  position: absolute;
  inset: 0;
  background: #070c17a8;
}
.settings-modal,.scoped-settings {
  position: absolute;
  border: 1px solid var(--line-strong);
  border-radius: 18px;
  background: var(--surface);
  box-shadow: 0 25px 70px #0005;
}
.global-modal {
  left: 245px;
  top: 53px;
  display: grid;
  grid-template-columns: 190px minmax(0,1fr);
  width: 700px;
}
.modal-navigation {
  border-right: 1px solid var(--line);
  background: var(--surface-2);
  border-radius: 18px 0 0 18px;
}
.navigation-heading {
  display: flex;
  align-items: center;
  gap: 9px;
  min-height: 58px;
  padding: 14px;
  border-bottom: 1px solid var(--line);
  font-size: 16px;
}
.navigation-group {
  display: grid;
  gap: 2px;
  padding: 7px;
  border-bottom: 1px solid var(--line);
}
.navigation-group > span {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 6px 8px;
  font-size: 12px;
  color: var(--muted);
}
.navigation-group .selected {
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--surface);
  color: var(--blue);
}
.global-content {
  min-width: 0;
}
.global-toolbar {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 22px;
  height: 58px;
  padding: 0 24px;
  color: var(--muted);
  font-size: 12px;
}
.modal-fields {
  display: grid;
  gap: 18px;
  padding: 12px 26px 22px;
}
.field {
  display: grid;
  gap: 6px;
  min-width: 0;
}
.field-label {
  color: var(--muted);
  font-size: 12px;
  font-weight: 500;
}
.field-value {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  min-width: 0;
  min-height: 45px;
  padding: 9px 12px;
  border: 1px solid var(--line-strong);
  border-radius: 11px;
  background: var(--surface);
  font-size: 14px;
  overflow-wrap: anywhere;
}
.field-value > span {
  min-width: 0;
}
.field-value > svg:not(.pointer) {
  flex: none;
  color: var(--muted);
}
.mono {
  font-family: ui-monospace,SFMono-Regular,monospace;
  font-size: 13px;
  overflow-wrap: anywhere;
}
.muted {
  color: var(--muted);
}
.value-stack {
  display: grid;
  min-width: 0;
}
.value-stack > * {
  grid-area: 1/1;
  min-width: 0;
  overflow-wrap: anywhere;
}
.phase-start,.reset-initial,.reset-cleared,.reset-local-endpoint,.reset-local-url,.reset-local-model,.reset-url-initial {
  opacity: 0;
}
.phase-end,.reset-final {
  opacity: 1;
}
.connection-summary {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  min-height: 62px;
  padding: 10px 12px;
  border: 1px solid var(--line-strong);
  border-radius: 11px;
  background: var(--surface);
}
.connection-summary > div {
  min-width: 0;
}
.connection-summary strong {
  font-weight: 500;
}
.connection-summary > svg {
  flex: none;
  color: var(--muted);
}
.connection-metadata {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 3px;
  color: var(--muted);
}
.source-badge {
  display: inline-flex;
  width: max-content;
  max-width: 100%;
  padding: 1px 5px;
  border: 1px solid var(--line);
  border-radius: 4px;
  background: var(--surface-2);
  color: var(--muted);
  font-size: 10px;
  font-weight: 500;
  line-height: 1.4;
}
.model-control .source-badge {
  display: block;
  margin-top: 3px;
}
.reasoning {
  display: grid;
  gap: 4px;
}
.reasoning > span {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  color: var(--muted);
  font-size: 12px;
}
.segments {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 3px;
  border: 1px solid var(--line);
  border-radius: 9px;
  background: var(--surface-2);
}
.segments > * {
  flex: 1;
  min-width: 0;
  padding: 4px 3px;
  border-radius: 6px;
  color: var(--muted);
  text-align: center;
  font-size: 11px;
  overflow-wrap: anywhere;
}
.segments > strong {
  background: var(--surface);
  color: var(--text);
  font-weight: 500;
}
.connection-details {
  display: grid;
  gap: 14px;
  padding: 16px;
  border-radius: 12px;
  background: var(--surface-2);
}
.header-editor {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  color: var(--muted);
  font-size: 11px;
}
.header-editor > span:last-child {
  padding: 4px 7px;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: var(--surface);
}
.modal-footer {
  display: flex;
  justify-content: flex-end;
  padding: 16px 24px;
  border-top: 1px solid var(--line);
}
.save-control {
  position: relative;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  border: 1px solid var(--line-strong);
  border-radius: 9px;
  background: #2563eb;
  color: #fff;
  font-size: 12px;
}
.save-control .phase-end {
  display: flex;
  align-items: center;
  gap: 5px;
}
.scoped-settings {
  left: 273px;
  top: 80px;
  width: 450px;
}
.group-page {
  left: 195px;
  top: 68px;
  width: 490px;
  border-radius: 0;
  box-shadow: none;
}
.modal-heading,.group-heading {
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 57px;
  padding: 14px 22px;
  border-bottom: 1px solid var(--line);
  font-size: 14px;
}
.modal-heading > svg {
  margin-left: auto;
  color: var(--muted);
}
.group-heading h3 {
  flex: 1;
  margin: 0;
  font-size: 14px;
  font-weight: 600;
}
.group-heading > svg {
  color: var(--muted);
}
.scoped-body {
  display: grid;
  gap: 15px;
  padding: 22px 26px;
}
.scoped-details {
  opacity: 1;
  animation: details-open var(--duration) linear infinite;
}
.disclosures {
  margin-top: 6px;
}
.disclosures > div {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 46px;
  border-top: 1px solid var(--line);
  color: var(--muted);
  font-size: 13px;
}
.restore-footer {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 6px;
  padding-top: 14px;
  border-top: 1px solid var(--line);
  color: var(--muted);
  font-size: 12px;
}
.select-menu {
  position: absolute;
  z-index: 8;
  top: calc(100% + 4px);
  left: 0;
  right: 0;
  display: grid;
  gap: 3px;
  padding: 6px;
  border: 1px solid var(--line-strong);
  border-radius: 10px;
  background: var(--surface);
  box-shadow: 0 12px 30px #0004;
  font-size: 12px;
  opacity: 0;
}
.select-menu > * {
  display: block;
  padding: 8px;
  border-radius: 6px;
  overflow-wrap: anywhere;
}
.select-menu > strong {
  background: var(--surface-2);
  color: var(--blue);
  font-weight: 500;
}
.pointer {
  position: absolute;
  z-index: 10;
  right: 6px;
  bottom: -12px;
  fill: var(--surface);
  color: var(--text);
  filter: drop-shadow(0 1px 2px #0007);
  opacity: 0;
  animation: tap-middle var(--duration) linear infinite;
}
.entry-pointer {
  animation-name: tap-entry;
}
.header-pointer {
  animation-name: tap-header;
}
.summary-pointer {
  animation-name: tap-summary;
}
.provider-pointer {
  animation-name: tap-provider;
}
.url-pointer {
  animation-name: tap-url;
}
.global-model-pointer,.model-pointer {
  animation-name: tap-model;
}
.save-pointer {
  animation-name: tap-save;
}
.endpoint-pointer {
  animation-name: tap-provider;
}
.reset-url-pointer {
  animation-name: tap-url;
}
.stage-global .global-modal,.stage-global .modal-veil {
  animation: modal-open 16s linear infinite;
}
.stage-inheritedChat .chat-modal,.stage-inheritedChat .chat-veil {
  animation: chat-modal-open 16s linear infinite;
}
.stage-global .provider-control .phase-start,.stage-group .endpoint-control .phase-start {
  animation: provider-before var(--duration) linear infinite;
}
.stage-global .provider-control .phase-end,.stage-group .endpoint-control .phase-end {
  animation: provider-after var(--duration) linear infinite;
}
.stage-global .url-control .phase-start {
  animation: url-before 16s linear infinite;
}
.stage-global .url-control .phase-end {
  animation: url-after 16s linear infinite;
}
.stage-global .model-control .phase-start,.stage-group .model-control .phase-start,.stage-chatModel .phase-start {
  animation: model-before var(--duration) linear infinite;
}
.stage-global .model-control .phase-end,.stage-group .model-control .phase-end,.stage-chatModel .phase-end {
  animation: model-after var(--duration) linear infinite;
}
.stage-global .save-control .phase-start {
  animation: save-before 16s linear infinite;
}
.stage-global .save-control .phase-end {
  animation: save-after 16s linear infinite;
}
.stage-group .endpoint-source {
  opacity: 0;
  animation: provider-before 16s linear infinite;
}
.stage-group .model-source,.stage-chatModel .model-source {
  opacity: 0;
  animation: model-before 16s linear infinite;
}
.provider-menu,.stage-group .endpoint-menu {
  animation: provider-menu var(--duration) linear infinite;
}
.model-menu {
  top: auto;
  bottom: calc(100% + 4px);
  animation: model-menu var(--duration) linear infinite;
}
.stage-chatModel .scoped-details {
  display: none;
}
.stage-reset .reset-initial {
  animation: reset-initial 22s linear infinite;
}
.stage-reset .reset-cleared {
  animation: reset-cleared 22s linear infinite;
}
.stage-reset .reset-local-endpoint {
  animation: reset-endpoint 22s linear infinite;
}
.stage-reset .reset-url-initial {
  animation: reset-url-initial 22s linear infinite;
}
.stage-reset .reset-local-url {
  animation: reset-url 22s linear infinite;
}
.stage-reset .reset-local-model {
  animation: reset-model 22s linear infinite;
}
.stage-reset .reset-final {
  animation: reset-final 22s linear infinite;
}
.stage-reset .endpoint-source {
  animation: reset-source 22s linear infinite;
}
.stage-reset .reset-model-source {
  animation: reset-model-source 22s linear infinite;
}
.stage-reset .endpoint-pointer {
  animation: tap-reset-endpoint 22s linear infinite;
}
.stage-reset .reset-endpoint-out-menu {
  animation: provider-menu 22s linear infinite;
}
.stage-reset .reset-model-menu {
  animation: model-menu 22s linear infinite;
}
.stage-reset .reset-endpoint-back-menu {
  animation: return-menu 22s linear infinite;
}
@keyframes focus-camera {
  0%,10%,100% {
    transform: translate(var(--entry-x),var(--entry-y)) scale(.85);
  }
  25%,32% {
    transform: translate(var(--focus-x),var(--summary-y)) scale(var(--focus-scale));
  }
  45%,94% {
    transform: translate(var(--focus-x),var(--focus-y)) scale(var(--focus-scale));
  }
}
@keyframes global-camera {
  0%,10%,100% {
    transform: translate(var(--entry-x),var(--entry-y)) scale(.85);
  }
  25%,43% {
    transform: translate(var(--focus-x),var(--summary-y)) scale(var(--focus-scale));
  }
  60%,94% {
    transform: translate(var(--focus-x),var(--focus-y)) scale(var(--focus-scale));
  }
}
@keyframes modal-open {
  0%,10%,100% {
    opacity: 0;
  }
  20%,94% {
    opacity: 1;
  }
}
@keyframes chat-modal-open {
  0%,24%,100% {
    opacity: 0;
  }
  32%,94% {
    opacity: 1;
  }
}
@keyframes header-menu {
  0%,9%,26%,100% {
    opacity: 0;
  }
  13%,23% {
    opacity: 1;
  }
}
@keyframes details-open {
  0%,32%,100% {
    opacity: 0;
  }
  39%,94% {
    opacity: 1;
  }
}
@keyframes provider-before {
  0%,42%,100% {
    opacity: 1;
  }
  46%,94% {
    opacity: 0;
  }
}
@keyframes provider-after {
  0%,42%,100% {
    opacity: 0;
  }
  46%,94% {
    opacity: 1;
  }
}
@keyframes url-before {
  0%,55%,100% {
    opacity: 1;
  }
  59%,94% {
    opacity: 0;
  }
}
@keyframes url-after {
  0%,55%,100% {
    opacity: 0;
  }
  59%,94% {
    opacity: 1;
  }
}
@keyframes model-before {
  0%,68%,100% {
    opacity: 1;
  }
  72%,94% {
    opacity: 0;
  }
}
@keyframes model-after {
  0%,68%,100% {
    opacity: 0;
  }
  72%,94% {
    opacity: 1;
  }
}
@keyframes save-before {
  0%,82%,100% {
    opacity: 1;
  }
  87%,94% {
    opacity: 0;
  }
}
@keyframes save-after {
  0%,82%,100% {
    opacity: 0;
  }
  87%,94% {
    opacity: 1;
  }
}
@keyframes provider-menu {
  0%,37%,45%,100% {
    opacity: 0;
  }
  39%,43% {
    opacity: 1;
  }
}
@keyframes model-menu {
  0%,62%,71%,100% {
    opacity: 0;
  }
  65%,69% {
    opacity: 1;
  }
}
@keyframes return-menu {
  0%,78%,85%,100% {
    opacity: 0;
  }
  80%,83% {
    opacity: 1;
  }
}
@keyframes tap-entry {
  0%,3%,13%,100% {
    opacity: 0;
    transform: translate(8px,8px);
  }
  6%,10% {
    opacity: 1;
    transform: none;
  }
}
@keyframes tap-header {
  0%,15%,25%,100% {
    opacity: 0;
    transform: translate(8px,8px);
  }
  18%,22% {
    opacity: 1;
    transform: none;
  }
}
@keyframes tap-summary {
  0%,30%,40%,100% {
    opacity: 0;
    transform: translate(8px,8px);
  }
  33%,37% {
    opacity: 1;
    transform: none;
  }
}
@keyframes tap-provider {
  0%,37%,47%,100% {
    opacity: 0;
    transform: translate(8px,8px);
  }
  40%,44% {
    opacity: 1;
    transform: none;
  }
}
@keyframes tap-url {
  0%,50%,61%,100% {
    opacity: 0;
    transform: translate(8px,8px);
  }
  53%,58% {
    opacity: 1;
    transform: none;
  }
}
@keyframes tap-model {
  0%,62%,73%,100% {
    opacity: 0;
    transform: translate(8px,8px);
  }
  65%,70% {
    opacity: 1;
    transform: none;
  }
}
@keyframes tap-save {
  0%,79%,89%,100% {
    opacity: 0;
    transform: translate(8px,8px);
  }
  82%,86% {
    opacity: 1;
    transform: none;
  }
}
@keyframes tap-middle {
  0%,35%,55%,100% {
    opacity: 0;
  }
  40%,50% {
    opacity: 1;
  }
}
@keyframes tap-reset-endpoint {
  0%,37%,47%,77%,87%,100% {
    opacity: 0;
    transform: translate(8px,8px);
  }
  40%,44%,80%,84% {
    opacity: 1;
    transform: none;
  }
}
@keyframes reset-initial {
  0%,42%,100% {
    opacity: 1;
  }
  46%,94% {
    opacity: 0;
  }
}
@keyframes reset-cleared {
  0%,42%,72%,100% {
    opacity: 0;
  }
  46%,68% {
    opacity: 1;
  }
}
@keyframes reset-endpoint {
  0%,42%,86%,100% {
    opacity: 0;
  }
  46%,83% {
    opacity: 1;
  }
}
@keyframes reset-url-initial {
  0%,55%,100% {
    opacity: 1;
  }
  59%,94% {
    opacity: 0;
  }
}
@keyframes reset-url {
  0%,55%,86%,100% {
    opacity: 0;
  }
  59%,83% {
    opacity: 1;
  }
}
@keyframes reset-model {
  0%,68%,86%,100% {
    opacity: 0;
  }
  72%,83% {
    opacity: 1;
  }
}
@keyframes reset-final {
  0%,83%,100% {
    opacity: 0;
  }
  86%,94% {
    opacity: 1;
  }
}
@keyframes reset-source {
  0%,42%,86%,100% {
    opacity: 1;
  }
  46%,83% {
    opacity: 0;
  }
}
@keyframes reset-model-source {
  0%,42%,72%,83%,100% {
    opacity: 0;
  }
  46%,68%,86%,94% {
    opacity: 1;
  }
}
@container (max-width:560px) {
  .scene-canvas {
    --focus-scale:.9;
    --focus-x:-232px;
    --focus-y:-185px;
    --summary-y:-108px;
  }
  .stage-global .scene-canvas {
    --focus-x:-402px;
    --focus-y:-200px;
    --summary-y:-75px;
  }
  .stage-group .scene-canvas {
    --focus-x:-165px;
    --focus-y:-185px;
    --summary-y:-95px;
  }
  .stage-chatModel .scene-canvas {
    --focus-y:-65px;
    --summary-y:-65px;
    --entry-x:-232px;
  }
  .stage-inheritedChat .scene-canvas,.stage-reset .scene-canvas {
    --entry-x:min(-490px,calc(100cqw - 820px));
  }
  /* Fit the active fields and pointers without reducing the focus scale. */
  .scoped-settings {
    width: min(360px,calc(100cqw + 4px));
  }
  .group-page {
    width: min(360px,calc(100cqw + 4px));
  }
  .global-modal {
    width: min(550px,calc(100cqw + 240px));
  }
  .scoped-body {
    padding: 18px;
    gap: 13px;
  }
  .modal-fields {
    padding: 12px 18px 18px;
    gap: 15px;
  }
  .mono {
    font-size: 12px;
  }
  .connection-metadata {
    gap: 4px;
  }
  .connection-details {
    padding: 12px;
  }
}
:global(html:has(#docs-pause-motion:checked) .camera-viewport *) {
  animation: none!important;
}
:global(html:has(#docs-pause-motion:checked) .stage-reset .scene-canvas) {
  transform: translate(var(--focus-x),var(--focus-y)) scale(var(--focus-scale));
}
:global(html:has(#docs-pause-motion:checked) .camera-viewport .pointer),
:global(html:has(#docs-pause-motion:checked) .camera-viewport .select-menu),
:global(html:has(#docs-pause-motion:checked) .camera-viewport .header-menu) {
  display: none;
}
@media(prefers-reduced-motion:reduce) {
  .camera-viewport * {
    animation: none!important;
  }
  .pointer,.select-menu,.header-menu {
    display: none;
  }
}
</style>
