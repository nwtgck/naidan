<script setup lang="ts">
import { ArrowDownIcon, ArrowUpIcon, CheckIcon, ChevronDownIcon, ChevronRightIcon, ClipboardPasteIcon, CopyIcon, DownloadIcon, ImageIcon, ListIcon, LoaderCircleIcon, MousePointer2Icon, PlusIcon, SquareIcon, Trash2Icon } from 'lucide-vue-next';
import skyKitten from '../../assets/flying-kitten.webp';
import gardenKitten from '../../pages/image-generation-multi-prompt/assets/garden-kitten.webp';
import bookshelfKitten from '../../pages/image-generation-multi-prompt/assets/bookshelf-kitten.webp';
import { multiPromptImageExamples } from '../../pages/image-generation-multi-prompt/examples';
import type { MultiPromptImageGuideMessages } from '../../messages/types';

const props = defineProps<{ stage: 'common' | 'inputs' | 'overrides' | 'generate' | 'compare' | 'save' | 'paste'; messages: MultiPromptImageGuideMessages }>();
const prompts = (() => {
  const stage = props.stage;
  switch (stage) {
  case 'inputs': return [props.messages.sky_prompt, props.messages.bookshelf_prompt, props.messages.garden_prompt];
  case 'common': case 'overrides': case 'generate': case 'compare': case 'save': case 'paste': return [props.messages.sky_prompt, props.messages.garden_prompt, props.messages.bookshelf_prompt];
  default: {
    const exhaustive: never = stage;
    throw new Error(String(exhaustive));
  }
  }
})();
const images = [skyKitten, gardenKitten, bookshelfKitten];
const examples = multiPromptImageExamples({ prompts: [props.messages.sky_prompt, props.messages.garden_prompt, props.messages.bookshelf_prompt] });
defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <div class="multi-camera" :class="`stage-${stage}`" :data-docs-animation="`multi-prompt-${stage}`" :data-testid="`multi-prompt-step-${stage}`" aria-hidden="true">
    <div class="canvas">
      <header class="workspace-title"><ImageIcon :size="19" /><strong>{{ messages.image_generation }}</strong></header>
      <div class="session-heading"><strong>{{ messages.new_session }}</strong><span>{{ messages.draft_saved }}</span></div>
      <div class="columns">
        <div class="editor">
          <div class="count panel"><span>{{ messages.images_per_run }}</span><span class="number-value">1</span></div>
          <div class="model panel"><small>{{ messages.image_model }}</small><div class="field"><strong>{{ messages.model_name }}</strong><ChevronDownIcon :size="15" /></div><div class="component-heading"><ChevronDownIcon :size="14" />{{ messages.components }}</div><div class="compute"><span>{{ messages.compute_with }}</span><strong>{{ messages.this_device }}<ChevronDownIcon :size="13" /></strong></div></div>
          <div class="composition-toolbar">
            <div class="mode"><span>{{ messages.single_prompt }}</span><strong>{{ messages.multiple_prompts }}</strong></div>
            <span class="add action"><PlusIcon :size="14" />{{ messages.add_request }}</span>
            <span class="paste-icon icon-control" :title="messages.paste"><ClipboardPasteIcon :size="16" /></span>
            <div v-if="stage === 'common'" class="single-mode"><span>{{ messages.prompt }}</span><span class="switch-action"><ListIcon :size="14" />{{ messages.multiple_prompts }}<MousePointer2Icon class="pointer" :size="21" /></span></div>
          </div>
          <div class="common-negative panel"><small>{{ messages.common_negative_prompt }}</small><span class="blank-field" /></div>
          <div v-if="stage === 'paste'" class="paste-panel panel" data-testid="multi-prompt-paste-panel">
            <strong>{{ messages.paste }}</strong>
            <pre class="pasted-text">{{ examples.yaml }}</pre>
            <span class="review action"><CheckIcon :size="14" />{{ messages.review }}</span>
            <div class="parsed-preview"><small>YAML · 3</small><ol><li v-for="prompt in prompts" :key="prompt">{{ prompt }}</li></ol><div class="import-actions"><span class="action"><PlusIcon :size="14" />{{ messages.append }}</span><span class="secondary">{{ messages.replace }}</span></div></div>
          </div>
          <div v-if="stage !== 'common' && stage !== 'paste'" class="request-list" data-testid="multi-prompt-request-list">
            <section v-for="(prompt, index) in prompts" :key="prompt" class="request-card panel" :class="`request-${index + 1}`">
              <div class="request-head"><span class="card-label"><span class="position"><span class="position-before">{{ index + 1 }}</span><span v-if="stage === 'inputs' && index > 0" class="position-after">{{ index === 1 ? 3 : 2 }}</span></span>{{ messages.prompt }}</span><span class="card-actions"><span class="up icon-control" :class="{ muted: index === 0 }" :title="messages.move_up"><ArrowUpIcon :size="14" /></span><span class="down icon-control" :class="{ muted: index === 2 }" :title="messages.move_down"><ArrowDownIcon :size="14" /></span><span class="duplicate icon-control" :title="messages.duplicate"><CopyIcon :size="14" /></span><span class="icon-control" :title="messages.remove"><Trash2Icon :size="14" /></span></span></div>
              <div class="prompt-text">{{ prompt }}</div>
              <div class="individual"><ChevronDownIcon v-if="stage === 'overrides' && index === 2" :size="13" /><ChevronRightIcon v-else :size="13" />{{ messages.individual_settings }}<span>{{ stage === 'overrides' && index === 2 ? 2 : 0 }}</span></div>
              <div v-if="stage === 'overrides' && index === 2" class="override-fields" data-testid="multi-prompt-individual-settings">
                <div class="override-row"><span>{{ messages.width }}</span><span class="override-value">768</span><span class="inherit"><span class="checkbox" />{{ messages.shared }}</span></div>
                <div class="override-row"><span>{{ messages.height }}</span><span class="override-value">768</span><span class="inherit"><span class="checkbox" />{{ messages.shared }}</span></div>
                <div class="override-row inherited"><span>{{ messages.seed }}</span><span>{{ messages.random_seed }}</span><span class="inherit"><span class="checkbox checked"><CheckIcon :size="11" /></span>{{ messages.shared }}</span></div>
              </div>
            </section>
          </div>
          <div class="generation-actions"><small v-if="stage !== 'common'">{{ messages.summary }}</small><div><span class="generate action"><ImageIcon :size="16" />{{ messages.generate_all }}</span><span class="secondary cancel-action"><SquareIcon :size="13" />{{ messages.stop }}</span></div></div>
          <div class="common-parameters panel"><div class="component-heading"><ChevronDownIcon :size="14" />{{ messages.image_size }}</div><div class="size-fields"><div><small>{{ messages.width }}</small><span class="field">1024</span></div><span>×</span><div><small>{{ messages.height }}</small><span class="field">1024</span></div></div></div>
        </div>
        <div class="results">
          <div v-if="stage === 'generate' || stage === 'compare' || stage === 'save'" class="monitor panel">
            <div class="monitor-frames">
              <div class="monitor-frame frame-one"><div class="monitor-label"><strong><span class="count-before">{{ messages.image_zero_generated }}</span><span class="count-after">{{ messages.image_one_generated }}</span></strong><span>{{ messages.request_one }}</span></div><div class="monitor-image"><img :src="skyKitten" alt="" /><span class="working"><LoaderCircleIcon :size="21" />{{ messages.generating }}</span></div></div>
              <div class="monitor-frame frame-two"><div class="monitor-label"><strong><span class="count-before">{{ messages.image_one_generated }}</span><span class="count-after">{{ messages.image_two_generated }}</span></strong><span>{{ messages.request_two }}</span></div><div class="monitor-image"><img :src="gardenKitten" alt="" /><span class="working"><LoaderCircleIcon :size="21" />{{ messages.generating }}</span></div></div>
              <div class="monitor-frame frame-three"><div class="monitor-label"><strong><span class="count-before">{{ messages.image_two_generated }}</span><span class="count-after">{{ messages.image_three_generated }}</span></strong><span class="request-status"><span class="count-before">{{ messages.request_three }}</span><span class="count-after">{{ messages.completed }}</span></span></div><div class="monitor-image"><img :src="bookshelfKitten" alt="" /><span class="working"><LoaderCircleIcon :size="21" />{{ messages.generating }}</span></div></div>
            </div>
          </div>
          <div v-else class="monitor empty-monitor panel">{{ messages.next_generation }}</div>
          <div v-if="stage === 'generate' || stage === 'compare' || stage === 'save'" class="saved-results panel">
            <div class="result-tabs"><strong>{{ messages.runs }}</strong><span>{{ messages.gallery }} · 3</span><span class="compare-tab">{{ messages.compare }}</span></div>
            <div class="operation" data-testid="multi-prompt-operation">
              <div class="operation-heading"><span><ChevronDownIcon :size="15" /><strong>{{ messages.generation_operation }}</strong><small>3</small></span><span class="download secondary"><DownloadIcon :size="14" />{{ messages.download_results_zip }}<span class="saved-count">3</span></span></div>
              <div v-for="(prompt, index) in [messages.sky_prompt, messages.garden_prompt, messages.bookshelf_prompt]" :key="prompt" class="saved-request" :class="`saved-${index + 1}`"><p>{{ prompt }}</p><small>{{ messages.model_name }} · {{ messages.completed }} · 1</small><div class="asset"><img :src="images[index]" alt="" /><span v-if="stage === 'compare' && index < 2" class="select-image checkbox checked"><CheckIcon :size="12" /></span></div></div>
            </div>
          </div>
          <div v-if="stage === 'compare'" class="compare-panel panel" data-testid="multi-prompt-comparison">
            <div class="result-tabs"><span>{{ messages.runs }}</span><span>{{ messages.gallery }} · 3</span><strong>{{ messages.compare }}</strong></div>
            <small>{{ messages.selected_two }}</small>
            <div class="comparison-images"><div><img :src="skyKitten" alt="" /><span>42</span></div><div><img :src="gardenKitten" alt="" /><span>43</span></div></div>
            <div class="comparison-table"><div><strong>prompt</strong><span>{{ messages.sky_prompt }}</span><span>{{ messages.garden_prompt }}</span></div><div><strong>seed</strong><span>42</span><span>43</span></div></div>
          </div>
          <div v-if="stage === 'save'" class="zip-dialog panel" data-testid="multi-prompt-zip-confirmation"><strong>{{ messages.zip_notice_title }}</strong><p>{{ messages.zip_notice }}</p><div><span class="secondary">{{ messages.cancel }}</span><span class="action">{{ messages.confirm }}</span></div></div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.multi-camera {
  --editor-width:min(370px,calc(100cqw - 28px));
  --results-width:min(470px,calc(100cqw - 28px));
  --result-x:calc(0px - var(--editor-width) - 12px);
  --rest-x:14px;
  --rest-y:-400px;
  --start-x:14px;
  --start-y:-270px;
  container-type: inline-size;
  position: relative;
  height: 460px;
  max-width: 680px;
  margin-inline: auto;
  overflow: hidden;
  border: 1px solid var(--line-strong);
  border-radius: 15px;
  background: var(--bg);
  box-shadow: var(--panel-shadow);
  color: var(--text);
  font: 13px/1.5 ui-sans-serif,system-ui,sans-serif;
}
.canvas {
  position: absolute;
  inset: 0 auto auto 0;
  width: calc(var(--editor-width) + var(--results-width) + 24px);
  transform-origin: top left;
  animation: camera-focus 12s ease-in-out infinite;
}
.workspace-title {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 48px;
  padding-inline: 14px;
  border-bottom: 1px solid var(--line);
  background: var(--surface);
  font-size: 16px;
}
.workspace-title svg {
  color: var(--blue);
}
.session-heading {
  display: flex;
  flex-direction: column;
  justify-content: center;
  height: 60px;
  padding-inline: 2px;
}
.session-heading > span,small {
  color: var(--muted);
  font-size: 11px;
}
.columns {
  display: grid;
  grid-template-columns: var(--editor-width) var(--results-width);
  align-items: start;
  gap: 24px;
}
.editor,.results {
  display: grid;
  align-content: start;
  gap: 12px;
  min-width: 0;
}
.panel {
  min-width: 0;
  border: 1px solid var(--line-strong);
  border-radius: 12px;
  background: var(--surface);
}
.count {
  display: flex;
  align-items: center;
  gap: 12px;
  height: 50px;
  padding: 8px 12px;
}
.number-value {
  min-width: 48px;
  padding: 5px 9px;
  border: 1px solid var(--line-strong);
  border-radius: 7px;
  background: var(--surface-2);
}
.model {
  height: 126px;
  padding: 10px 12px;
}
.field {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-height: 34px;
  margin-top: 4px;
  padding: 6px 9px;
  border: 1px solid var(--line-strong);
  border-radius: 8px;
  background: var(--surface-2);
}
.component-heading {
  display: flex;
  align-items: center;
  gap: 5px;
  margin-top: 8px;
  font-size: 11px;
  font-weight: 600;
}
.compute {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 7px;
  color: var(--muted);
  font-size: 11px;
}
.compute strong {
  display: flex;
  align-items: center;
  gap: 7px;
  color: var(--text);
  font-weight: 500;
}
.composition-toolbar {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 6px;
  min-height: 50px;
}
.mode {
  display: flex;
  flex-wrap: wrap;
  gap: 2px;
  padding: 3px;
  border-radius: 8px;
  background: var(--surface-2);
  color: var(--muted);
  font-size: 11px;
}
.mode > * {
  padding: 4px 6px;
  border-radius: 5px;
  font-weight: 500;
}
.mode strong {
  color: var(--blue);
  background: var(--surface);
}
.action,.secondary {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-height: 32px;
  padding: 6px 9px;
  border: 1px solid var(--line-strong);
  border-radius: 8px;
  font-size: 11px;
  line-height: 1.5;
}
.action {
  border-color: color-mix(in srgb,var(--blue) 40%,var(--line));
  background: color-mix(in srgb,var(--blue) 8%,var(--surface));
}
.action svg {
  flex: none;
  color: var(--blue);
}
.secondary {
  background: var(--surface);
}
.icon-control {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 28px;
  flex: none;
  border-radius: 6px;
  color: var(--muted);
}
.paste-icon {
  width: 32px;
  border: 1px solid var(--line-strong);
}
.single-mode {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  gap: 10px;
  background: var(--bg);
}
.switch-action {
  position: relative;
  display: flex;
  align-items: center;
  gap: 5px;
  color: var(--muted);
}
.pointer {
  position: absolute;
  right: -9px;
  bottom: -16px;
  fill: var(--surface);
  color: var(--text);
  filter: drop-shadow(0 2px 2px #0005);
}
.common-negative {
  display: grid;
  gap: 8px;
  height: 78px;
  padding: 9px 12px;
  background: var(--surface-2);
}
.blank-field {
  display: block;
  min-height: 25px;
}
.request-list {
  display: grid;
  gap: 10px;
}
.request-card {
  height: 120px;
  overflow: hidden;
}
.request-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 4px;
  height: 34px;
  padding-inline: 9px;
}
.card-label {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  color: var(--muted);
  font-size: 11px;
}
.position {
  display: grid;
  min-width: 20px;
  padding: 1px 4px;
  border-radius: 5px;
  background: var(--surface-2);
  font-size: 10px;
  text-align: center;
}
.position > span {
  grid-area: 1/1;
}
.position-after {
  opacity: 0;
}
.card-actions {
  display: flex;
  align-items: center;
  gap: 1px;
}
.muted {
  opacity: .35;
}
.prompt-text {
  height: 55px;
  padding: 4px 12px;
  overflow-wrap: anywhere;
}
.individual {
  display: flex;
  align-items: center;
  gap: 5px;
  height: 30px;
  padding-inline: 9px;
  border-top: 1px solid var(--line);
  color: var(--muted);
  font-size: 11px;
}
.individual > span {
  margin-left: auto;
}
.override-fields {
  padding: 0 10px;
}
.override-row {
  display: grid;
  grid-template-columns: minmax(0,1fr) minmax(0,1fr) auto;
  align-items: center;
  gap: 8px;
  height: 46px;
  border-top: 1px solid var(--line);
  font-size: 11px;
}
.override-value {
  padding: 5px 8px;
  border: 1px solid var(--line-strong);
  border-radius: 6px;
  background: var(--surface-2);
}
.inherit {
  display: flex;
  align-items: center;
  gap: 5px;
  color: var(--muted);
}
.checkbox {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 14px;
  height: 14px;
  flex: none;
  border: 1px solid var(--line-strong);
  border-radius: 3px;
  background: var(--surface);
}
.checkbox.checked {
  border-color: var(--blue);
  color: white;
  background: var(--blue);
}
.inherited {
  color: var(--muted);
}
.generation-actions {
  display: grid;
  gap: 6px;
}
.generation-actions > div {
  display: flex;
  gap: 7px;
}
.generate {
  flex: 1;
  min-height: 42px;
  font-size: 12px;
  font-weight: 600;
}
.cancel-action {
  opacity: .4;
}
.common-parameters {
  min-height: 110px;
  padding: 10px 12px;
}
.common-parameters .component-heading {
  margin-top: 0;
}
.size-fields {
  display: grid;
  grid-template-columns: minmax(0,1fr) 12px minmax(0,1fr);
  align-items: end;
  gap: 8px;
  margin-top: 8px;
}
.size-fields > span {
  padding-bottom: 8px;
  color: var(--muted);
}
.monitor {
  height: 336px;
  padding: 14px;
}
.empty-monitor {
  display: grid;
  place-items: center;
  color: var(--muted);
}
.monitor-frames {
  display: grid;
}
.monitor-frame {
  grid-area: 1/1;
  min-width: 0;
}
.monitor-label {
  display: grid;
  gap: 5px;
  min-height: 57px;
}
.monitor-label strong,.request-status {
  display: grid;
  font-size: 13px;
}
.monitor-label strong > span,.request-status > span {
  grid-area: 1/1;
}
.monitor-label strong > span {
  color: var(--text);
  font-size: 13px;
}
.count-before {
  opacity: 0;
}
.monitor-label span {
  color: var(--muted);
  font-size: 11px;
}
.monitor-image {
  position: relative;
  display: grid;
  place-items: center;
  height: 246px;
  overflow: hidden;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--surface-2);
}
.monitor-image img {
  width: 100%;
  height: 100%;
  object-fit: contain;
}
.working {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  background: var(--surface-2);
  color: var(--muted);
  font-size: 12px;
  opacity: 0;
}
.frame-one,.frame-two {
  opacity: 0;
}
.saved-results {
  padding: 12px;
}
.result-tabs {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  min-height: 37px;
  margin-bottom: 12px;
  color: var(--muted);
  font-size: 12px;
}
.result-tabs > * {
  padding: 6px 8px;
  border-radius: 8px;
}
.result-tabs strong {
  color: var(--text);
  background: var(--surface-2);
  font-weight: 600;
}
.operation {
  border: 1px solid var(--line-strong);
  border-radius: 10px;
  overflow: hidden;
}
.operation-heading {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 7px;
  padding: 8px;
  background: var(--surface-2);
}
.operation-heading > span:first-child {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
}
.operation-heading strong {
  font-weight: 500;
}
.operation-heading small {
  padding: 1px 5px;
  border-radius: 5px;
  background: var(--surface);
}
.download {
  gap: 4px;
  font-size: 10px;
}
.download svg {
  color: var(--blue);
}
.saved-count {
  margin-left: 2px;
  padding-left: 6px;
  border-left: 1px solid var(--line);
  color: var(--muted);
}
.saved-request {
  margin: 0 10px;
  padding-block: 10px;
  border-bottom: 1px solid var(--line);
}
.saved-request:last-child {
  border-bottom: 0;
}
.saved-request p {
  margin: 0 0 3px;
  overflow-wrap: anywhere;
  font-size: 12px;
}
.saved-request small {
  font-size: 10px;
}
.asset {
  position: relative;
  width: 104px;
  height: 90px;
  margin-top: 7px;
  overflow: hidden;
  border: 1px solid var(--line);
  border-radius: 7px;
  background: var(--surface-2);
}
.asset img {
  width: 100%;
  height: 100%;
  object-fit: contain;
}
.select-image {
  position: absolute;
  top: 5px;
  left: 5px;
}
.compare-panel {
  position: absolute;
  left: calc(var(--editor-width) + 24px);
  top: 108px;
  width: var(--results-width);
  min-height: 340px;
  padding: 12px;
}
.comparison-images {
  display: grid;
  grid-template-columns: minmax(0,1fr) minmax(0,1fr);
  gap: 10px;
  margin-top: 12px;
}
.comparison-images > div {
  display: grid;
  gap: 5px;
  min-width: 0;
  color: var(--muted);
  font: 11px/1.5 ui-monospace,monospace;
}
.comparison-images img {
  display: block;
  width: 100%;
  height: 150px;
  object-fit: contain;
  border-radius: 8px;
  background: var(--surface-2);
}
.comparison-table {
  margin-top: 12px;
  overflow: hidden;
  border: 1px solid var(--line-strong);
  border-radius: 8px;
}
.comparison-table > div {
  display: grid;
  grid-template-columns: 52px minmax(0,1fr) minmax(0,1fr);
  border-bottom: 1px solid var(--line);
  font-size: 11px;
}
.comparison-table > div:last-child {
  border-bottom: 0;
}
.comparison-table > div > * {
  padding: 7px;
  overflow-wrap: anywhere;
  font-weight: 400;
}
.comparison-table strong {
  color: var(--muted);
}
.zip-dialog {
  position: absolute;
  top: 520px;
  left: calc(var(--editor-width) + 24px);
  z-index: 3;
  width: var(--results-width);
  padding: 20px;
  box-shadow: 0 15px 45px #0005;
}
.zip-dialog > strong {
  font-size: 15px;
}
.zip-dialog p {
  margin: 14px 0 20px;
  font-size: 13px;
  line-height: 1.5;
  overflow-wrap: anywhere;
}
.zip-dialog > div {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
.paste-panel {
  padding: 12px;
}
.paste-panel > strong {
  font-size: 12px;
}
.pasted-text {
  height: 154px;
  margin: 10px 0;
  padding: 9px;
  overflow: hidden;
  border: 1px solid var(--line-strong);
  border-radius: 8px;
  background: var(--surface-2);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font: 11px/1.7 ui-monospace,monospace;
}
.parsed-preview {
  margin-top: 10px;
}
.parsed-preview ol {
  margin: 7px 0 12px;
  padding-left: 22px;
  font-size: 12px;
}
.parsed-preview li {
  padding-block: 4px;
  overflow-wrap: anywhere;
}
.import-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.stage-common {
  --start-y:-4px;
  --rest-y:-250px;
}
.stage-common .single-mode {
  animation: single-mode 12s linear infinite;
}
.stage-common .mode,.stage-common .add,.stage-common .paste-icon,.stage-common .common-negative {
  animation: multiple-mode 12s linear infinite;
}
.stage-common .switch-action {
  animation: control-focus 12s linear infinite;
}
.stage-common .generation-actions {
  margin-top: 0;
}
.stage-common .generate {
  opacity: .4;
}
.stage-common .cancel-action {
  display: none;
}
.stage-inputs .add {
  animation: add-focus 12s linear infinite;
}
.stage-inputs .request-2 {
  animation: add-second 12s linear infinite;
}
.stage-inputs .request-3 {
  animation: add-third 12s linear infinite;
}
.stage-inputs .request-2 .duplicate {
  animation: duplicate-focus 12s linear infinite;
}
.stage-inputs .request-3 .up {
  animation: move-focus 12s linear infinite;
}
.stage-inputs .request-2 .position-before,.stage-inputs .request-3 .position-before {
  animation: position-before 12s linear infinite;
}
.stage-inputs .position-after {
  animation: position-after 12s linear infinite;
}
.stage-inputs .request-2 .down {
  animation: down-disabled 12s linear infinite;
}
.stage-inputs .request-3 .down {
  animation: down-enabled 12s linear infinite;
}
.stage-overrides {
  --start-y:-640px;
  --rest-y:-690px;
}
.stage-overrides .request-3 {
  height: 260px;
}
.stage-overrides .override-value {
  animation: override-focus 12s linear infinite;
}
.stage-generate {
  --start-y:-800px;
  --rest-x:var(--result-x);
  --rest-y:-96px;
}
.stage-generate .canvas {
  animation: generate-camera 14s ease-in-out infinite;
}
.stage-generate .generate {
  animation: generate-focus 14s linear infinite;
}
.stage-generate .composition-toolbar,.stage-generate .request-list {
  animation: list-disabled 14s linear infinite;
}
.stage-generate .cancel-action {
  animation: cancel-enabled 14s linear infinite;
}
.stage-generate .monitor-frame {
  animation: frame-one 14s linear infinite;
}
.stage-generate .frame-two {
  animation-name: frame-two;
}
.stage-generate .frame-three {
  animation-name: frame-three;
}
.stage-generate .frame-one .working {
  animation: work-one 14s linear infinite;
}
.stage-generate .frame-two .working {
  animation: work-two 14s linear infinite;
}
.stage-generate .frame-three .working {
  animation: work-three 14s linear infinite;
}
.stage-generate .frame-one .count-before {
  animation: work-one 14s linear infinite;
}
.stage-generate .frame-two .count-before {
  animation: work-two 14s linear infinite;
}
.stage-generate .frame-three .count-before {
  animation: work-three 14s linear infinite;
}
.stage-generate .frame-one .count-after {
  animation: saved-one 14s linear infinite;
}
.stage-generate .frame-two .count-after {
  animation: saved-two 14s linear infinite;
}
.stage-generate .frame-three .count-after {
  animation: saved-three 14s linear infinite;
}
.stage-generate .working svg {
  animation: spinner 1.5s linear infinite;
}
.stage-generate .saved-1 {
  animation: saved-one 14s linear infinite;
}
.stage-generate .saved-2 {
  animation: saved-two 14s linear infinite;
}
.stage-generate .saved-3 {
  animation: saved-three 14s linear infinite;
}
.stage-compare {
  --start-x:var(--result-x);
  --start-y:-430px;
  --rest-x:var(--result-x);
  --rest-y:-96px;
}
.stage-compare .compare-panel {
  animation: comparison-open 12s linear infinite;
}
.stage-compare .select-image {
  animation: selection-show 12s linear infinite;
}
.stage-compare .compare-tab {
  animation: comparison-focus 12s linear infinite;
}
.stage-save {
  --start-x:var(--result-x);
  --start-y:-430px;
  --rest-x:var(--result-x);
  --rest-y:-450px;
}
.stage-save .download {
  animation: control-focus 12s linear infinite;
}
.stage-save .zip-dialog {
  animation: comparison-open 12s linear infinite;
}
.stage-save .zip-dialog .action {
  animation: override-focus 12s linear infinite;
}
.stage-paste {
  --start-y:-400px;
  --rest-y:-555px;
}
.stage-paste .review {
  animation: control-focus 12s linear infinite;
}
.stage-paste .parsed-preview {
  animation: preview-show 12s linear infinite;
}
@keyframes camera-focus {
  0%,12%,100% {
    transform: translate(var(--start-x),var(--start-y));
  }
  55%,94% {
    transform: translate(var(--rest-x),var(--rest-y));
  }
}
@keyframes single-mode {
  0%,24%,100% {
    opacity: 1;
  }
  36%,94% {
    opacity: 0;
  }
}
@keyframes multiple-mode {
  0%,24%,100% {
    opacity: 0;
  }
  36%,94% {
    opacity: 1;
  }
}
@keyframes control-focus {
  0%,10%,32%,100% {
    box-shadow: none;
  }
  16%,26% {
    box-shadow: 0 0 0 4px color-mix(in srgb,var(--blue) 24%,transparent);
  }
}
@keyframes add-focus {
  0%,10%,27%,100% {
    box-shadow: none;
  }
  15%,22% {
    box-shadow: 0 0 0 4px color-mix(in srgb,var(--blue) 24%,transparent);
  }
}
@keyframes add-second {
  0%,24%,100% {
    opacity: 0;
    transform: none;
  }
  31%,60% {
    opacity: 1;
    transform: none;
  }
  72%,94% {
    opacity: 1;
    transform: translateY(130px);
  }
}
@keyframes add-third {
  0%,42%,100% {
    opacity: 0;
    transform: none;
  }
  49%,60% {
    opacity: 1;
    transform: none;
  }
  72%,94% {
    opacity: 1;
    transform: translateY(-130px);
  }
}
@keyframes duplicate-focus {
  0%,33%,45%,100% {
    color: var(--muted);
    background: transparent;
  }
  36%,42% {
    color: var(--blue);
    background: var(--surface-2);
  }
}
@keyframes move-focus {
  0%,53%,64%,100% {
    color: var(--muted);
    background: transparent;
  }
  56%,61% {
    color: var(--blue);
    background: var(--surface-2);
  }
}
@keyframes position-before {
  0%,64%,100% {
    opacity: 1;
  }
  72%,94% {
    opacity: 0;
  }
}
@keyframes position-after {
  0%,64%,100% {
    opacity: 0;
  }
  72%,94% {
    opacity: 1;
  }
}
@keyframes down-disabled {
  0%,64%,100% {
    opacity: 1;
  }
  72%,94% {
    opacity: .35;
  }
}
@keyframes down-enabled {
  0%,64%,100% {
    opacity: .35;
  }
  72%,94% {
    opacity: 1;
  }
}
@keyframes list-disabled {
  0%,9%,90%,100% {
    opacity: 1;
  }
  12%,84% {
    opacity: .45;
  }
}
@keyframes cancel-enabled {
  0%,9%,84%,100% {
    opacity: .4;
  }
  12%,80% {
    opacity: 1;
  }
}
@keyframes override-focus {
  0%,40%,100% {
    border-color: var(--line-strong);
  }
  52%,85% {
    border-color: var(--blue);
  }
}
@keyframes generate-camera {
  0%,9%,100% {
    transform: translate(var(--start-x),var(--start-y));
  }
  22%,94% {
    transform: translate(var(--rest-x),var(--rest-y));
  }
}
@keyframes generate-focus {
  0%,3%,16%,100% {
    box-shadow: none;
  }
  6%,12% {
    box-shadow: 0 0 0 4px color-mix(in srgb,var(--blue) 24%,transparent);
  }
}
@keyframes frame-one {
  0%,39%,100% {
    opacity: 1;
  }
  40%,99% {
    opacity: 0;
  }
}
@keyframes frame-two {
  0%,39%,62%,100% {
    opacity: 0;
  }
  40%,61% {
    opacity: 1;
  }
}
@keyframes frame-three {
  0%,61%,100% {
    opacity: 0;
  }
  62%,99% {
    opacity: 1;
  }
}
@keyframes work-one {
  0%,28%,100% {
    opacity: 1;
  }
  35%,99% {
    opacity: 0;
  }
}
@keyframes work-two {
  0%,48%,100% {
    opacity: 1;
  }
  56%,99% {
    opacity: 0;
  }
}
@keyframes work-three {
  0%,70%,100% {
    opacity: 1;
  }
  80%,99% {
    opacity: 0;
  }
}
@keyframes saved-one {
  0%,33%,100% {
    opacity: 0;
  }
  38%,99% {
    opacity: 1;
  }
}
@keyframes saved-two {
  0%,55%,100% {
    opacity: 0;
  }
  60%,99% {
    opacity: 1;
  }
}
@keyframes saved-three {
  0%,79%,100% {
    opacity: 0;
  }
  84%,99% {
    opacity: 1;
  }
}
@keyframes comparison-open {
  0%,40%,100% {
    opacity: 0;
  }
  51%,94% {
    opacity: 1;
  }
}
@keyframes selection-show {
  0%,14%,100% {
    opacity: 0;
  }
  23%,94% {
    opacity: 1;
  }
}
@keyframes comparison-focus {
  0%,28%,48%,100% {
    color: var(--muted);
    background: transparent;
  }
  34%,44% {
    color: var(--blue);
    background: var(--surface-2);
  }
}
@keyframes preview-show {
  0%,25%,100% {
    opacity: 0;
  }
  37%,94% {
    opacity: 1;
  }
}
@keyframes spinner {
  to {
    transform: rotate(360deg);
  }
}
html:has(#docs-pause-motion:checked) .multi-camera *,html:has(#docs-pause-motion:checked) .multi-camera *::before,html:has(#docs-pause-motion:checked) .multi-camera *::after {
  animation: none!important;
}
html:has(#docs-pause-motion:checked) .multi-camera .canvas {
  transform: translate(var(--rest-x),var(--rest-y));
}
html:has(#docs-pause-motion:checked) .multi-camera .pointer,html:has(#docs-pause-motion:checked) .stage-common .single-mode {
  display: none;
}
html:has(#docs-pause-motion:checked) .stage-inputs .request-2 {
  transform: translateY(130px);
}
html:has(#docs-pause-motion:checked) .stage-inputs .request-3 {
  transform: translateY(-130px);
}
html:has(#docs-pause-motion:checked) .stage-inputs .request-2 .position-before,html:has(#docs-pause-motion:checked) .stage-inputs .request-3 .position-before {
  opacity: 0;
}
html:has(#docs-pause-motion:checked) .stage-inputs .position-after {
  opacity: 1;
}
html:has(#docs-pause-motion:checked) .stage-inputs .request-2 .down {
  opacity: .35;
}
html:has(#docs-pause-motion:checked) .stage-inputs .request-3 .down {
  opacity: 1;
}
@media(prefers-reduced-motion:reduce) {
  .multi-camera *,.multi-camera *::before,.multi-camera *::after {
    animation: none!important;
  }
  .canvas {
    transform: translate(var(--rest-x),var(--rest-y));
  }
  .pointer,.stage-common .single-mode {
    display: none;
  }
  .stage-inputs .request-2 {
    transform: translateY(130px);
  }
  .stage-inputs .request-3 {
    transform: translateY(-130px);
  }
  .stage-inputs .request-2 .position-before,.stage-inputs .request-3 .position-before {
    opacity: 0;
  }
  .stage-inputs .position-after {
    opacity: 1;
  }
  .stage-inputs .request-2 .down {
    opacity: .35;
  }
  .stage-inputs .request-3 .down {
    opacity: 1;
  }
}
@media(max-width:520px) {
  .composition-toolbar {
    min-height: 72px;
  }
  .mode {
    flex-basis: 100%;
    width: max-content;
  }
  .add {
    margin-left: auto;
  }
  .stage-common {
    --rest-y:-270px;
  }
  .stage-inputs {
    --rest-y:-422px;
  }
  .stage-overrides {
    --start-y:-662px;
    --rest-y:-712px;
  }
  .stage-generate {
    --start-y:-822px;
  }
  .stage-paste {
    --start-y:-422px;
    --rest-y:-577px;
  }
  .comparison-images img {
    height: 140px;
  }
}
</style>
