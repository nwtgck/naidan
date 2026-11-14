<script setup lang="ts">
import { AlertTriangleIcon, ArrowUpIcon, ArrowDownIcon, ChevronDownIcon, DownloadIcon, GripVerticalIcon, HistoryIcon, LayersIcon, MousePointer2Icon, PlayIcon, PlusIcon, SaveIcon, SquareIcon, WorkflowIcon } from 'lucide-vue-next';
import logo from '../../assets/naidan.svg';
import type { WorkflowGuideMessages } from '../../messages/types';

const props = defineProps<{ stage: 'edit' | 'connection' | 'run' | 'results' | 'reuse'; messages: WorkflowGuideMessages }>();
const sceneLabels = {
  edit: props.messages.edit_scene_label,
  connection: props.messages.connection_scene_label,
  run: props.messages.run_scene_label,
  results: props.messages.results_scene_label,
  reuse: props.messages.reuse_scene_label,
};

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <div class="workflow-demo" :class="`stage-${stage}`" :data-docs-animation="`workflow-${stage}`" role="img" :aria-label="sceneLabels[stage]">
    <div class="address"><img :src="logo" alt="" width="16" height="16"><span>Naidan</span><code>/#/workflows</code></div>
    <div class="camera" data-testid="workflow-camera">
      <div class="app-canvas" :class="{ 'editor-canvas': stage === 'edit' || stage === 'connection' }">
        <aside class="workflow-sidebar">
          <strong><WorkflowIcon :size="16" />{{ messages.workflows }}</strong>
          <div v-if="stage === 'reuse'" class="library-item">{{ messages.example_name }}</div>
          <span class="history-link"><HistoryIcon :size="14" />{{ messages.run_history }}</span>
          <span class="latest-link">{{ messages.latest_run }}</span>
        </aside>
        <div class="workspace">
          <header class="workspace-header">
            <div class="definition-name"><small>{{ messages.workflows }}</small><strong>{{ messages.example_name }}</strong><span class="save-state">{{ stage === 'reuse' ? messages.saved : messages.unsaved }}</span></div>
            <div class="header-actions">
              <span class="control save-action"><SaveIcon :size="14" />{{ messages.save }}</span>
              <span class="execution-control">
                <span class="control primary run-action" :class="{ 'before-start': stage === 'run' || stage === 'reuse' }" data-testid="workflow-start-action"><PlayIcon :size="14" data-testid="workflow-start-icon" />{{ messages.run }}<MousePointer2Icon v-if="stage === 'run' || stage === 'reuse'" class="pointer run-pointer" :size="22" /></span>
                <span v-if="stage === 'run' || stage === 'reuse'" class="control stop-action after-start" data-testid="workflow-stop-action"><SquareIcon :size="14" data-testid="workflow-stop-icon" />{{ messages.stop }}</span>
              </span>
            </div>
            <div class="experimental"><AlertTriangleIcon :size="14" /><span>{{ messages.experimental_notice }}</span></div>
            <div class="view-tabs"><span :class="{ active: stage === 'edit' || stage === 'connection' }"><LayersIcon :size="13" />{{ messages.steps }}</span><span>JSON</span><span data-testid="workflow-dependencies-tab">{{ messages.graph }}</span><span :class="{ active: stage === 'run' || stage === 'results' || stage === 'reuse' }">{{ messages.results }}</span></div>
          </header>

          <div v-if="stage === 'edit' || stage === 'connection'" class="editor-layout">
            <div class="step-list">
              <div v-for="(name, index) in [messages.input_name, messages.summary_name, messages.share_name]" :key="name" class="step-card" :class="{ selected: index === 2 }"><GripVerticalIcon :size="14" /><span class="selection-box" :class="{ checked: index === 2 }" /><div><strong>{{ name }}</strong><small>{{ index === 0 ? messages.request_input : messages.generate_text }}</small></div><ArrowUpIcon :size="12" /><ArrowDownIcon :size="12" /></div>
              <div class="add-step"><PlusIcon :size="14" />{{ messages.add_step }}</div>
            </div>
            <div class="step-editor">
              <small class="type-label">{{ messages.generate_text }}</small>
              <div class="field"><span>{{ messages.name }}</span><div class="field-box">{{ messages.share_name }}</div></div>
              <template v-if="stage === 'connection'">
                <div class="model-heading"><strong data-testid="workflow-model-heading">{{ messages.model }}</strong><span class="control">{{ messages.use_current_settings }}</span></div>
                <div class="field"><span>{{ messages.choose_value }}</span><div class="field-box">{{ messages.model }}<ChevronDownIcon :size="14" /></div></div>
                <div class="field connection-focus"><span>{{ messages.endpoint }}</span><div class="field-box">Ollama<ChevronDownIcon :size="14" /></div><div class="field-box monospace">http://localhost:11434</div></div>
                <div class="field"><span>{{ messages.model_id }}</span><div class="field-box monospace">qwen3:8b<MousePointer2Icon class="pointer model-pointer" :size="22" /></div></div>
              </template>
              <template v-else>
                <strong class="message-heading">{{ messages.append_messages }}</strong>
                <div class="message-editor">
                  <div class="field"><span>{{ messages.role }}</span><div class="field-box">user<ChevronDownIcon :size="14" /></div></div>
                  <div class="field"><span>{{ messages.choose_value }}</span><div class="field-box">{{ messages.fixed_text }}<ChevronDownIcon :size="14" /></div><p class="text-field">{{ messages.share_instruction }}</p></div>
                  <div class="reference-focus" data-testid="workflow-reference"><div class="field"><span>{{ messages.choose_value }}</span><div class="field-box">{{ messages.step_output }}<ChevronDownIcon :size="14" /></div></div><div class="field"><span>{{ messages.source }}</span><div class="field-box source-choice">{{ messages.summary_name }} · text<ChevronDownIcon :size="14" /><MousePointer2Icon class="pointer reference-pointer" :size="22" /></div></div></div>
                  <span class="add-text"><PlusIcon :size="12" />{{ messages.add_text }}</span>
                </div>
              </template>
            </div>
          </div>

          <div v-else class="results-pane" :class="{ 'after-start': stage === 'run' || stage === 'reuse' }" data-testid="workflow-execution-pane">
            <template v-if="stage === 'run' || stage === 'reuse'">
              <div class="run-state"><strong>{{ messages.waiting }}</strong></div>
              <div class="pending-input">
                <strong>{{ messages.input_name }}</strong><p>{{ messages.input_prompt }}</p>
                <div class="text-field input-text" data-testid="workflow-input-text">{{ stage === 'reuse' ? messages.next_notes_example : messages.notes_example }}</div>
                <span class="control continue-action">{{ messages.continue }}<MousePointer2Icon class="pointer continue-pointer" :size="22" /></span>
              </div>
            </template>
            <template v-else>
              <div class="run-state"><strong>{{ messages.completed }}</strong><span class="control"><DownloadIcon :size="14" />{{ messages.download_zip }}</span></div>
              <div v-for="(entry, index) in [{ name: messages.input_name, text: messages.notes_example }, { name: messages.summary_name, text: messages.summary_example }, { name: messages.share_name, text: messages.share_example }]" :key="entry.name" class="result-card" :class="`result-${index}`" data-testid="workflow-output-card">
                <header><span>{{ index + 1 }}</span><strong>{{ entry.name }}</strong><small>{{ messages.completed }}</small></header>
                <span class="preview-label" data-testid="workflow-output-label">{{ messages.output_preview }}</span><p>{{ entry.text }}</p>
              </div>
            </template>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.workflow-demo {
  --focus-width: min(420px, calc(100cqw - 2px));
  --editor-x: min(-90px, calc(100cqw - 432px - var(--focus-width)));
  --result-x: min(0px, calc(100cqw - 152px - var(--focus-width)));
  --editor-y: -350px;
  --run-y: -115px;
  --results-y: -180px;
  border: 1px solid var(--line-strong);
  border-radius: 16px;
  overflow: hidden;
  color: var(--text);
  background: var(--bg);
  font-family: ui-sans-serif,system-ui,sans-serif;
  text-align: left;
  container-type: inline-size;
  box-shadow: 0 18px 48px #0002;
}
.address {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 11px 14px;
  border-bottom: 1px solid var(--line);
  background: var(--surface-2);
  font-size: 11px;
}
.address code {
  margin-inline-start: auto;
  color: var(--muted);
  font-size: 10px;
}
.camera {
  position: relative;
  height: 430px;
  overflow: hidden;
  background: var(--surface);
}
.app-canvas {
  display: grid;
  grid-template-columns: 150px var(--focus-width);
  width: calc(150px + var(--focus-width));
  min-height: 720px;
  transform: translate(var(--result-x), var(--run-y));
}
.editor-canvas {
  grid-template-columns: 150px calc(280px + var(--focus-width));
  width: calc(430px + var(--focus-width));
  transform: translate(var(--editor-x), var(--editor-y));
}
.workflow-sidebar {
  display: flex;
  flex-direction: column;
  gap: 15px;
  border-inline-end: 1px solid var(--line);
  padding: 18px 12px;
  font-size: 11px;
  background: var(--surface);
}
.workflow-sidebar > strong,.history-link {
  display: flex;
  align-items: center;
  gap: 6px;
}
.workflow-sidebar > strong {
  color: var(--blue);
}
.library-item {
  border: 1px solid var(--line-strong);
  border-radius: 10px;
  padding: 12px 8px;
  background: var(--surface-2);
  overflow-wrap: anywhere;
}
.history-link {
  margin-top: 26px;
}
.latest-link {
  color: var(--blue);
  font-size: 11px;
}
.workspace {
  min-width: 0;
  background: var(--bg);
}
.workspace-header {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 14px;
  padding: 15px;
  border-bottom: 1px solid var(--line);
}
.definition-name {
  display: flex;
  flex: 1;
  min-width: 150px;
  flex-direction: column;
  gap: 3px;
}
.definition-name small {
  color: var(--blue);
  font-size: 10px;
}
.definition-name strong {
  font-size: 16px;
}
.save-state {
  color: var(--muted);
  font-size: 10px;
}
.header-actions {
  display: flex;
  gap: 6px;
}
.execution-control {
  display: grid;
}
.execution-control > .control {
  grid-area: 1/1;
}
.before-start {
  visibility: hidden;
}
.after-start {
  visibility: visible;
}
.control {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  padding: 8px 10px;
  border: 1px solid var(--line-strong);
  border-radius: 8px;
  background: var(--bg);
  font-size: 11px;
  line-height: 1.5;
}
.primary {
  background: #2563eb;
  border-color: #2563eb;
  color: white;
}
.stop-action {
  background: #dc2626;
  border-color: #dc2626;
  color: white;
}
.experimental {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  width: 100%;
  padding: 8px;
  border-radius: 7px;
  color: var(--muted);
  background: var(--surface-2);
  font-size: 10px;
  line-height: 1.5;
}
.experimental svg {
  flex: none;
}
.view-tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 7px;
  font-size: 11px;
}
.view-tabs > span {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 7px 9px;
  border: 1px solid var(--line);
  border-radius: 8px;
}
.view-tabs .active {
  color: var(--blue);
  border-color: var(--blue);
}
.editor-layout {
  display: grid;
  grid-template-columns: 280px var(--focus-width);
}
.step-list {
  padding: 16px;
  background: var(--surface);
  border-inline-end: 1px solid var(--line);
}
.step-card {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 12px 8px;
  margin-bottom: 13px;
  border: 1px solid var(--line);
  border-radius: 12px;
  background: var(--bg);
}
.step-card svg {
  flex: none;
  color: var(--muted);
}
.step-card > div {
  flex: 1;
  min-width: 0;
}
.step-card strong {
  display: block;
  font-size: 12px;
}
.step-card small {
  display: block;
  margin-top: 4px;
  font-size: 9px;
  color: var(--muted);
}
.step-card.selected {
  border-color: var(--blue);
}
.selection-box {
  width: 10px;
  height: 10px;
  border: 1px solid var(--line-strong);
  border-radius: 3px;
}
.selection-box.checked {
  background: var(--blue);
}
.add-step {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  padding: 10px;
  border: 1px solid var(--blue);
  border-radius: 10px;
  color: var(--blue);
  font-size: 12px;
}
.step-editor {
  padding: 18px;
  min-width: 0;
}
.type-label {
  display: block;
  color: var(--blue);
  font-size: 11px;
  margin-bottom: 10px;
}
.field {
  display: grid;
  gap: 6px;
  margin-bottom: 13px;
}
.field > span {
  font-size: 11px;
  color: var(--muted);
}
.field-box {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  min-width: 0;
  padding: 10px;
  border: 1px solid var(--line-strong);
  border-radius: 11px;
  font-size: 12px;
  line-height: 1.5;
  background: var(--surface);
  overflow-wrap: anywhere;
}
.field-box svg {
  flex: none;
}
.monospace {
  font-family: ui-monospace,monospace;
  font-size: 11px;
}
.message-heading {
  display: block;
  margin: 18px 0 10px;
  font-size: 12px;
}
.message-editor {
  padding: 12px;
  border: 1px solid var(--line);
  border-radius: 12px;
  background: var(--surface);
}
.text-field {
  margin: 0;
  padding: 11px;
  min-height: 70px;
  border: 1px solid var(--line-strong);
  border-radius: 10px;
  background: var(--bg);
  font-size: 12px;
  line-height: 1.8;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}
.message-editor .text-field {
  height: 82px;
  min-height: 0;
  overflow: hidden;
}
.source-choice {
  border-color: var(--blue);
}
.add-text {
  display: flex;
  align-items: center;
  gap: 4px;
  color: var(--blue);
  font-size: 11px;
}
.model-heading {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
  margin: 16px 0;
  font-size: 12px;
}
.model-heading .control {
  font-size: 10px;
  max-width: 190px;
}
.results-pane {
  padding: 14px;
}
.run-state {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 12px;
  font-size: 14px;
}
.pending-input {
  border: 1px solid var(--blue);
  border-radius: 12px;
  padding: 14px;
  background: color-mix(in srgb,var(--blue) 7%,var(--bg));
}
.pending-input > strong {
  font-size: 14px;
}
.pending-input > p {
  margin: 8px 0;
  font-size: 12px;
  line-height: 1.6;
}
.continue-action {
  margin-top: 12px;
}
.result-card {
  margin-bottom: 12px;
  padding: 12px;
  border: 1px solid var(--line);
  border-radius: 12px;
}
.result-card header {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11px;
}
.result-card header > span {
  color: var(--muted);
}
.result-card header > small {
  margin-inline-start: auto;
  color: var(--blue);
  font-size: 10px;
}
.preview-label {
  display: block;
  margin-top: 9px;
  color: var(--muted);
  font-size: 10px;
}
.result-card p {
  margin: 5px 0 0;
  font-size: 12px;
  line-height: 1.7;
  white-space: pre-line;
  overflow-wrap: anywhere;
}
.pointer {
  position: absolute;
  right: 4px;
  bottom: -12px;
  color: var(--text);
  fill: var(--bg);
  filter: drop-shadow(0 2px 2px #0004);
  opacity: 0;
}
.reference-pointer,.model-pointer {
  animation: workflow-point 10s linear infinite;
}
.stage-edit .app-canvas {
  animation: workflow-edit-camera 10s ease-in-out infinite;
}
.stage-connection {
  --editor-y: -185px;
}
.stage-connection .app-canvas {
  animation: workflow-model-camera 10s ease-in-out infinite;
}
.stage-run .app-canvas,.stage-reuse .app-canvas {
  animation: workflow-run-camera 12s ease-in-out infinite;
}
.stage-run .continue-pointer,.stage-reuse .continue-pointer {
  animation: workflow-continue 12s linear infinite;
}
.stage-run .run-pointer,.stage-reuse .run-pointer {
  animation: workflow-run-point 12s linear infinite;
}
.stage-run .before-start,.stage-reuse .before-start {
  animation: workflow-before-start 12s steps(1,end) infinite;
}
.stage-run .after-start,.stage-reuse .after-start {
  animation: workflow-after-start 12s steps(1,end) infinite;
}
.stage-results .app-canvas {
  transform: translate(var(--result-x), var(--results-y));
  animation: workflow-results-camera 14s ease-in-out infinite;
}
.stage-results .camera {
  height: 520px;
}
@keyframes workflow-point {
  0%,35%,75%,100% {
    opacity: 0;
    transform: translate(10px,8px);
  }
  44%,65% {
    opacity: 1;
    transform: none;
  }
}
@keyframes workflow-edit-camera {
  0%,15%,100% {
    transform: translate(var(--editor-x), -70px);
  }
  35%,88% {
    transform: translate(var(--editor-x), var(--editor-y));
  }
}
@keyframes workflow-model-camera {
  0%,15%,100% {
    transform: translate(var(--editor-x), -65px);
  }
  35%,88% {
    transform: translate(var(--editor-x), var(--editor-y));
  }
}
@keyframes workflow-run-camera {
  0%,16%,100% {
    transform: translate(var(--result-x), 0);
  }
  32%,90% {
    transform: translate(var(--result-x), var(--run-y));
  }
}
@keyframes workflow-run-point {
  0%,5%,20%,100% {
    opacity: 0;
  }
  9%,15% {
    opacity: 1;
  }
}
@keyframes workflow-before-start {
  0%,17% {
    visibility: visible;
  }
  18%,100% {
    visibility: hidden;
  }
}
@keyframes workflow-after-start {
  0%,17% {
    visibility: hidden;
  }
  18%,100% {
    visibility: visible;
  }
}
@keyframes workflow-continue {
  0%,42%,67%,100% {
    opacity: 0;
  }
  48%,60% {
    opacity: 1;
  }
}
@keyframes workflow-results-camera {
  0%,20%,100% {
    transform: translate(var(--result-x), -125px);
  }
  50%,88% {
    transform: translate(var(--result-x), var(--results-y));
  }
}
html:has(#docs-pause-motion:checked) .workflow-demo * {
  animation: none !important;
}
html:has(#docs-pause-motion:checked) .workflow-demo .pointer {
  display: none;
}
@media (prefers-reduced-motion: reduce) {
  .workflow-demo * {
    animation: none !important;
  }
  .workflow-demo .pointer {
    display: none;
  }
}
@media (max-width: 760px) {
  .workflow-demo {
    --run-y: -280px;
    --results-y: -300px;
  }
  .stage-connection {
    --editor-y: -230px;
  }
  .camera {
    height: 470px;
  }
  .stage-results .camera {
    height: 660px;
  }
}
</style>
