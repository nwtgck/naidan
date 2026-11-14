<script setup lang="ts">
import { ArrowLeftRightIcon, ArrowRightIcon, BrainCircuitIcon, ChevronDownIcon, ChevronRightIcon, CopyIcon, DownloadIcon, FilePenLineIcon, FolderOpenIcon, LanguagesIcon, LibraryBigIcon, Loader2Icon, MousePointer2Icon, PlusIcon, SlidersHorizontalIcon, SquareIcon, Trash2Icon } from 'lucide-vue-next';
import HomeBrowserFrame from './HomeBrowserFrame.vue';
import type { TranslationGuideMessages } from '../../messages/types';

defineProps<{ stage: 'model' | 'translate' | 'options'; messages: TranslationGuideMessages }>();
defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <div class="translation-scene" :class="`stage-${stage}`" :data-docs-animation="`translation-${stage}`" :data-testid="`translation-step-${stage}`" aria-hidden="true">
    <HomeBrowserFrame identity="naidan" :tab-label="messages.naidan">
      <div class="translation-camera">
        <div class="translation-canvas" data-testid="translation-canvas">
          <aside class="translation-sidebar"><LanguagesIcon :size="18" /><FolderOpenIcon :size="18" /></aside>
          <main class="workspace">
            <h3 class="workspace-title"><LanguagesIcon :size="21" />{{ messages.translation }}</h3>
            <div class="selected-model" data-testid="translation-selected-model"><FilePenLineIcon :size="17" /><div><strong>{{ messages.selected_model_name }}</strong><small>{{ messages.selected_model_source }}</small></div><ChevronDownIcon :size="16" /></div>
            <div class="languages"><div class="language-field"><small>{{ messages.source_language }}</small><span>{{ messages.detect_language }}<ChevronDownIcon :size="14" /></span></div><ArrowLeftRightIcon class="swap" :size="16" /><div class="language-field"><small>{{ messages.target_language }}</small><span>{{ messages.japanese }}<ChevronDownIcon :size="14" /></span></div></div>
            <div class="editors">
              <section class="editor source-editor" data-testid="translation-source-replica"><header><strong>{{ messages.source_text }}</strong><span>{{ messages.clear }}</span></header><div class="editor-text"><span v-if="stage === 'model'" class="placeholder">{{ messages.enter_source_text }}</span><span v-else class="typed-source" lang="en"><span v-for="(character, index) in messages.sample_source" :key="index" class="source-character" :style="{ '--character': index }">{{ character }}</span></span></div><footer><span class="automatic-control"><span class="switch" /><span>{{ messages.automatic_translation }}</span><SlidersHorizontalIcon :size="14" /></span></footer></section>
              <section class="editor output-editor" data-testid="translation-output-replica"><header><strong>{{ messages.translated_text }}</strong><span class="copy-action"><CopyIcon :size="13" /><span class="copy-before">{{ messages.copy }}</span><span class="copy-after">{{ messages.copied }}</span><MousePointer2Icon class="copy-pointer" :size="21" /></span></header><div class="editor-text"><span v-if="stage === 'model'" class="placeholder">{{ messages.translation_appears_here }}</span><span v-else class="streamed-text" lang="ja"><span v-for="(character, index) in messages.sample_translation" :key="index" class="output-character" :style="{ '--character': index }">{{ character }}</span></span></div><footer><span class="translation-status"><Loader2Icon :size="13" />{{ messages.translating }}</span><span class="stop-action"><SquareIcon :size="12" />{{ messages.stop }}</span></footer></section>
            </div>
            <section class="translation-options" data-testid="translation-options-replica"><div class="options-summary"><SlidersHorizontalIcon :size="16" /><strong>{{ messages.translation_options }}</strong><ChevronRightIcon class="options-chevron" :size="15" /><MousePointer2Icon class="options-pointer" :size="21" /></div><div class="options-fields"><div class="style-field"><small>{{ messages.japanese_style }}</small><div class="static-select">{{ messages.polite_style }}<ChevronDownIcon :size="14" /></div></div><div class="context-field"><small>{{ messages.reference_context }}</small><div class="context-value">{{ messages.sample_context }}</div></div><div class="glossary-field"><small>{{ messages.glossary }}</small><div class="term-row"><div><small>{{ messages.source_term }}</small><span lang="en">{{ messages.sample_source_term }}</span></div><div><small>{{ messages.translated_term }}</small><span lang="ja">{{ messages.sample_translated_term }}</span></div><Trash2Icon :size="15" /></div><span class="add-term"><PlusIcon :size="13" />{{ messages.add_term }}</span></div></div></section>
            <section v-if="stage === 'model'" class="model-catalog" data-testid="translation-catalog-replica"><h4>{{ messages.translation_models }}</h4><div class="model-tabs"><strong>{{ messages.candidate_models }}</strong><span>Hugging Face</span><span>{{ messages.models_on_your_device }}</span></div><div class="catalog-heading"><LibraryBigIcon :size="17" /><strong>{{ messages.model_catalog }}</strong><ChevronDownIcon :size="14" /></div><div class="destination"><small>{{ messages.download_to }}</small><span>{{ messages.browser_storage }}<ChevronDownIcon :size="13" /></span></div><div class="model-card"><div class="model-heading"><span class="brain-icon"><BrainCircuitIcon :size="17" /></span><strong>{{ messages.model_name }}</strong><span class="variant">{{ messages.model_variant }}</span></div><div class="model-actions"><span class="developer">Preferred Networks</span><span class="candidate-action"><span class="download-action"><DownloadIcon :size="14" />{{ messages.download }}</span><span class="use-action">{{ messages.use_this_model }}<ArrowRightIcon :size="14" /></span><MousePointer2Icon class="model-pointer" :size="21" /></span></div></div></section>
          </main>
        </div>
      </div>
    </HomeBrowserFrame>
  </div>
</template>

<style scoped>
.translation-scene {
  container-type: inline-size;
  max-width: 720px;
  margin-inline: auto;
  color: var(--text);
  font: 12px/1.5 ui-sans-serif,system-ui,sans-serif;
}
.translation-camera {
  position: relative;
  height: 370px;
  overflow: hidden;
  background: var(--surface);
}
.translation-canvas {
  --panel-width: 310px;
  position: absolute;
  inset: 0 auto auto 0;
  display: grid;
  grid-template-columns: 48px 670px;
  width: 718px;
  min-height: 900px;
  transform-origin: 0 0;
}
.translation-sidebar {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 22px;
  padding-top: 28px;
  border-right: 1px solid var(--line);
  background: var(--surface);
  color: var(--muted);
}
.translation-sidebar > svg:first-child {
  color: var(--blue);
}
.workspace {
  position: relative;
  width: 670px;
  padding: 18px;
  background: var(--surface);
}
.workspace-title {
  display: flex;
  align-items: center;
  gap: 10px;
  height: 32px;
  margin: 0 0 14px;
  font-size: 20px;
  font-weight: 600;
}
.workspace-title > svg {
  color: var(--blue);
}
.selected-model {
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 50px;
  padding: 9px 13px;
  border: 1px solid var(--line-strong);
  border-radius: 12px;
  background: var(--surface-2);
}
.selected-model > svg {
  flex: none;
  color: var(--muted);
}
.selected-model > div {
  flex: 1;
  min-width: 0;
}
.selected-model strong,.selected-model small {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.selected-model strong {
  font-size: 12px;
  font-weight: 500;
}
.selected-model small {
  margin-top: 2px;
  color: var(--muted);
  font-size: 10px;
}
.languages {
  position: relative;
  display: grid;
  grid-template-columns: var(--panel-width) var(--panel-width);
  gap: 14px;
  margin-top: 16px;
}
.language-field > small {
  display: block;
  margin-bottom: 6px;
  color: var(--muted);
  font-size: 11px;
}
.language-field > span,.static-select {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  height: 36px;
  padding: 0 12px;
  border: 1px solid var(--line-strong);
  border-radius: 10px;
  background: var(--surface-2);
}
.swap {
  position: absolute;
  left: calc(var(--panel-width) - 1px);
  bottom: 10px;
  width: 16px;
  padding: 1px;
  border-radius: 4px;
  background: var(--surface);
  color: var(--muted);
}
.editors {
  display: grid;
  grid-template-columns: var(--panel-width) var(--panel-width);
  gap: 14px;
  margin-top: 14px;
}
.editor {
  display: flex;
  flex-direction: column;
  min-width: 0;
  height: 246px;
  overflow: hidden;
  border: 1px solid var(--line-strong);
  border-radius: 12px;
  background: var(--surface);
}
.editor > header {
  display: flex;
  flex: none;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  height: 42px;
  padding: 0 13px;
  border-bottom: 1px solid var(--line);
  color: var(--muted);
  font-size: 11px;
}
.editor > header > strong {
  font-weight: 500;
}
.editor > header > span {
  font-size: 10px;
}
.editor-text {
  flex: 1;
  min-height: 0;
  padding: 16px 14px;
  font-size: 14px;
  line-height: 1.9;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}
.placeholder {
  color: var(--subtle);
  font-size: 12px;
}
.editor > footer {
  display: flex;
  flex: none;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  height: 49px;
  padding: 0 12px;
  border-top: 1px solid var(--line);
  color: var(--muted);
  font-size: 10px;
}
.automatic-control {
  display: flex;
  align-items: center;
  gap: 6px;
  white-space: nowrap;
}
.automatic-control > svg {
  margin-left: 3px;
}
.switch {
  position: relative;
  flex: none;
  width: 25px;
  height: 14px;
  border-radius: 20px;
  background: var(--blue);
}
.switch::after {
  position: absolute;
  top: 2px;
  right: 2px;
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: #fff;
  content: '';
}
.output-editor {
  background: var(--surface-2);
}
.copy-action {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  min-width: 54px;
  justify-content: end;
}
.copy-after {
  display: none;
}
.copy-pointer,.model-pointer,.options-pointer {
  position: absolute;
  z-index: 3;
  fill: var(--surface);
  color: var(--text);
  filter: drop-shadow(0 1px 2px #0005);
}
.copy-pointer {
  right: 3px;
  top: 12px;
  opacity: 0;
}
.translation-status,.stop-action {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  visibility: hidden;
}
.stop-action {
  padding: 6px 9px;
  border: 1px solid var(--line-strong);
  border-radius: 7px;
}
.translation-options {
  width: 634px;
  margin-top: 16px;
  overflow: hidden;
  border: 1px solid var(--line-strong);
  border-radius: 12px;
}
.options-summary {
  position: relative;
  display: flex;
  align-items: center;
  gap: 11px;
  min-height: 42px;
  padding: 10px 13px;
}
.options-summary > svg:first-child {
  flex: none;
  color: var(--blue);
}
.options-summary > strong {
  flex: 1;
  font-weight: 500;
}
.options-chevron {
  flex: none;
}
.options-pointer {
  right: 15px;
  top: 22px;
  opacity: 0;
}
.options-fields {
  display: grid;
  gap: 13px;
  padding: 13px;
  border-top: 1px solid var(--line);
}
.options-fields small {
  display: block;
  margin-bottom: 6px;
  color: var(--muted);
  font-size: 11px;
}
.style-field {
  max-width: 310px;
}
.static-select {
  height: 32px;
}
.context-value {
  min-height: 48px;
  padding: 9px 11px;
  border: 1px solid var(--line-strong);
  border-radius: 10px;
  background: var(--surface-2);
  font-size: 12px;
  line-height: 1.65;
}
.term-row {
  display: grid;
  grid-template-columns: minmax(0,1fr) minmax(0,1fr) 18px;
  align-items: end;
  gap: 8px;
}
.term-row > div {
  min-width: 0;
}
.term-row small {
  font-size: 10px;
}
.term-row span {
  display: block;
  padding: 7px 9px;
  border: 1px solid var(--line-strong);
  border-radius: 8px;
  background: var(--surface-2);
  overflow-wrap: anywhere;
}
.term-row > svg {
  margin-bottom: 8px;
  color: var(--muted);
}
.add-term {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  margin-top: 9px;
  padding: 5px 9px;
  border: 1px solid var(--line-strong);
  border-radius: 7px;
  color: var(--muted);
  font-size: 10px;
}
.model-catalog {
  position: absolute;
  top: 64px;
  left: 18px;
  z-index: 2;
  width: 634px;
  min-height: 300px;
  padding-bottom: 30px;
  background: var(--surface);
  animation: translation-catalog 12s linear infinite both;
}
.model-catalog h4 {
  margin: 0 0 10px;
  color: var(--muted);
  font-size: 12px;
  font-weight: 600;
}
.model-tabs {
  display: flex;
  align-items: end;
  gap: 22px;
  height: 40px;
  border-bottom: 1px solid var(--line);
  font-size: 11px;
  white-space: nowrap;
  color: var(--subtle);
}
.model-tabs > * {
  padding-bottom: 12px;
}
.model-tabs > strong {
  color: var(--blue);
  border-bottom: 2px solid var(--blue);
  font-weight: 600;
}
.catalog-heading {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 14px;
  padding: 11px 0;
  color: var(--muted);
}
.catalog-heading > svg:first-child {
  color: var(--blue);
}
.catalog-heading > strong {
  flex: 1;
  font-size: 12px;
  font-weight: 600;
}
.destination {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin: 18px 0 12px;
  font-size: 10px;
  color: var(--muted);
}
.destination > small {
  font-size: 10px;
}
.destination > span {
  display: flex;
  align-items: center;
  gap: 8px;
}
.model-card {
  padding: 13px;
  border: 1px solid var(--line-strong);
  border-radius: 12px;
  background: var(--surface-2);
}
.model-heading {
  display: flex;
  align-items: center;
  gap: 9px;
  flex-wrap: wrap;
}
.model-heading > strong {
  font-size: 13px;
  font-weight: 600;
}
.brain-icon {
  display: grid;
  place-items: center;
  width: 30px;
  height: 30px;
  border-radius: 8px;
  background: color-mix(in srgb,var(--blue) 7%,transparent);
  color: var(--blue);
}
.variant {
  color: var(--muted);
  font-size: 10px;
}
.model-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-top: 12px;
}
.developer {
  color: var(--muted);
  font-size: 10px;
}
.candidate-action {
  position: relative;
  display: grid;
  align-items: center;
  min-height: 30px;
  padding: 5px 9px;
  border: 1px solid var(--line-strong);
  border-radius: 7px;
  font-size: 10px;
}
.download-action,.use-action {
  grid-area: 1/1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
}
.download-action > svg,.use-action > svg {
  color: var(--blue);
}
.download-action {
  animation: translation-download-label 12s linear infinite both;
}
.use-action {
  animation: translation-use-label 12s linear infinite both;
}
.model-pointer {
  right: 8px;
  bottom: -11px;
  animation: translation-model-pointer 12s linear infinite both;
}
.stage-model .selected-model,.stage-model .languages,.stage-model .editors,.stage-model .translation-options {
  animation: translation-workspace 12s linear infinite both;
}
.stage-model .translation-camera {
  height: 430px;
}
.stage-translate .translation-canvas {
  transform: translate(0,-106px);
}
.stage-translate .typed-source {
  animation: translation-input-mask 12s linear infinite both;
}
.stage-translate .source-character {
  animation: translation-input-character 12s linear infinite both;
  animation-delay: calc(var(--character) * .03952s);
}
.stage-translate .streamed-text {
  animation: translation-output-mask 12s linear infinite both;
}
.stage-translate .output-character {
  opacity: 0;
  animation: translation-output-character 12s linear infinite both;
  animation-delay: calc(var(--character) * .075s);
}
.stage-translate .copy-pointer {
  animation: translation-copy-pointer 12s linear infinite both;
}
.stage-translate .copy-before {
  animation: translation-copy-before 12s linear infinite both;
}
.stage-translate .copy-after {
  display: inline;
  animation: translation-copy-after 12s linear infinite both;
}
.stage-translate .copy-before,.stage-translate .copy-after {
  grid-area: 1/1;
}
.stage-translate .copy-action {
  display: grid;
  grid-template-columns: 13px auto;
  gap: 5px;
}
.stage-translate .copy-action > svg:first-child {
  grid-column: 1;
  grid-row: 1;
}
.stage-translate .copy-action > span {
  grid-column: 2;
  grid-row: 1;
}
.stage-translate .translation-status,.stage-translate .stop-action {
  animation: translation-generating 12s linear infinite both;
}
.stage-translate .translation-status > svg {
  animation: translation-spinner 1.3s linear infinite;
}
.stage-options .translation-camera {
  height: 460px;
}
.stage-options .translation-canvas {
  transform: translate(0,-464px);
}
.stage-options .translation-options {
  animation: translation-options-focus 12s linear infinite both;
}
.stage-options .options-fields {
  animation: translation-options-reveal 12s linear infinite both;
}
.stage-options .options-chevron {
  transform: rotate(90deg);
  animation: translation-options-chevron 12s linear infinite both;
}
.stage-options .options-pointer {
  animation: translation-options-pointer 12s linear infinite both;
}
.stage-options .style-field .static-select {
  animation: translation-style-focus 12s linear infinite both;
}
.stage-options .context-value {
  animation: translation-context-focus 12s linear infinite both;
}
.stage-options .term-row span {
  animation: translation-term-focus 12s linear infinite both;
}
@keyframes translation-catalog {
  0%,45% {
    opacity: 1;
    visibility: visible;
  }
  51%,100% {
    opacity: 0;
    visibility: hidden;
  }
}
@keyframes translation-workspace {
  0%,48% {
    opacity: 0;
  }
  55%,100% {
    opacity: 1;
  }
}
@keyframes translation-download-label {
  0%,22% {
    opacity: 1;
  }
  23%,100% {
    opacity: 0;
  }
}
@keyframes translation-use-label {
  0%,22% {
    opacity: 0;
  }
  23%,100% {
    opacity: 1;
  }
}
@keyframes translation-model-pointer {
  0%,5% {
    opacity: 0;
    transform: translate(18px,14px);
  }
  12%,17%,32%,37% {
    opacity: 1;
    transform: translate(0,0);
  }
  18%,20%,38%,40% {
    opacity: 1;
    transform: translate(-2px,-3px) scale(.9);
  }
  22%,29% {
    opacity: 0;
    transform: translate(6px,5px);
  }
  45%,100% {
    opacity: 0;
    transform: translate(0,0);
  }
}
@keyframes translation-input-mask {
  0%,85% {
    opacity: 1;
  }
  86%,100% {
    opacity: 0;
  }
}
@keyframes translation-input-character {
  0%,.5% {
    opacity: 0;
  }
  .51%,87% {
    opacity: 1;
  }
  87.01%,100% {
    opacity: 0;
  }
}
@keyframes translation-output-mask {
  0%,19%,86%,100% {
    opacity: 0;
  }
  20%,85% {
    opacity: 1;
  }
}
@keyframes translation-output-character {
  0%,20% {
    opacity: 0;
  }
  20.01%,100% {
    opacity: 1;
  }
}
@keyframes translation-copy-before {
  0%,64%,92%,100% {
    opacity: 1;
  }
  65%,91% {
    opacity: 0;
  }
}
@keyframes translation-copy-after {
  0%,64%,92%,100% {
    opacity: 0;
  }
  65%,91% {
    opacity: 1;
  }
}
@keyframes translation-copy-pointer {
  0%,55% {
    opacity: 0;
    transform: translate(12px,13px);
  }
  61%,63%,67%,71% {
    opacity: 1;
    transform: translate(0,0);
  }
  64%,66% {
    opacity: 1;
    transform: translate(-2px,-3px) scale(.9);
  }
  77%,100% {
    opacity: 0;
    transform: translate(7px,8px);
  }
}
@keyframes translation-generating {
  0%,20%,42%,100% {
    visibility: hidden;
  }
  21%,41% {
    visibility: visible;
  }
}
@keyframes translation-spinner {
  to {
    transform: rotate(360deg);
  }
}
@keyframes translation-options-focus {
  0%,11% {
    max-height: 42px;
  }
  18%,100% {
    max-height: 460px;
  }
}
@keyframes translation-options-reveal {
  0%,12% {
    opacity: 0;
  }
  21%,100% {
    opacity: 1;
  }
}
@keyframes translation-options-chevron {
  0%,11% {
    transform: rotate(0);
  }
  18%,100% {
    transform: rotate(90deg);
  }
}
@keyframes translation-options-pointer {
  0%,3%,20%,100% {
    opacity: 0;
  }
  7%,10%,15% {
    opacity: 1;
    transform: translate(0,0);
  }
  11%,13% {
    opacity: 1;
    transform: translate(-2px,-3px) scale(.9);
  }
}
@keyframes translation-style-focus {
  0%,23%,39%,100% {
    border-color: var(--line-strong);
  }
  28%,35% {
    border-color: var(--blue);
  }
}
@keyframes translation-context-focus {
  0%,41%,62%,100% {
    border-color: var(--line-strong);
  }
  46%,57% {
    border-color: var(--blue);
  }
}
@keyframes translation-term-focus {
  0%,64%,86%,100% {
    border-color: var(--line-strong);
  }
  69%,81% {
    border-color: var(--blue);
  }
}
html:has(#docs-pause-motion:checked) .translation-scene .translation-canvas *,
html:has(#docs-pause-motion:checked) .translation-scene .translation-canvas {
  animation: none!important;
}
html:has(#docs-pause-motion:checked) .translation-scene .model-catalog,
html:has(#docs-pause-motion:checked) .translation-scene .copy-pointer,
html:has(#docs-pause-motion:checked) .translation-scene .options-pointer,
html:has(#docs-pause-motion:checked) .stage-translate .copy-before {
  opacity: 0;
  visibility: hidden;
}
html:has(#docs-pause-motion:checked) .stage-translate .copy-after {
  display: inline;
  opacity: 1;
}
html:has(#docs-pause-motion:checked) .translation-scene .source-character,
html:has(#docs-pause-motion:checked) .translation-scene .output-character,
html:has(#docs-pause-motion:checked) .translation-scene .typed-source,
html:has(#docs-pause-motion:checked) .translation-scene .streamed-text,
html:has(#docs-pause-motion:checked) .translation-scene .options-fields {
  opacity: 1;
}
html:has(#docs-pause-motion:checked) .stage-options .translation-options {
  max-height: 460px;
}
@media(prefers-reduced-motion:reduce) {
  .translation-canvas,.translation-canvas * {
    animation: none!important;
  }
  .model-catalog,.copy-pointer,.options-pointer,.stage-translate .copy-before {
    opacity: 0;
    visibility: hidden;
  }
  .stage-translate .copy-after {
    display: inline;
    opacity: 1;
  }
  .source-character,.output-character,.typed-source,.streamed-text,.options-fields {
    opacity: 1;
  }
  .stage-options .translation-options {
    max-height: 460px;
  }
}
@container(max-width:718px) {
  .translation-canvas {
    --panel-width: min(310px,calc(100cqw - 28px));
    transform: translate(-52px,0);
  }
  .selected-model,.translation-options,.model-catalog {
    width: min(310px,calc(100cqw - 28px));
  }
  .model-tabs {
    display: grid;
    grid-template-columns: repeat(3,minmax(0,1fr));
    gap: 14px;
  }
  .model-tabs > * {
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .model-card {
    padding: 11px;
  }
  .model-heading {
    gap: 7px;
  }
  .model-heading > strong {
    font-size: 12px;
  }
  .brain-icon {
    width: 25px;
    height: 25px;
  }
  .variant {
    margin-left: 32px;
    margin-top: -5px;
  }
  .model-actions {
    flex-wrap: wrap;
  }
  .candidate-action {
    margin-left: auto;
  }
  .stage-translate .translation-canvas {
    --input-x: -52px;
    --output-x: calc(-66px - var(--panel-width));
    transform: translate(var(--output-x),-106px);
    animation: translation-narrow-camera 12s ease-in-out infinite both;
  }
  .stage-options .translation-canvas {
    transform: translate(-52px,-464px);
  }
  .model-catalog {
    min-height: 300px;
  }
  .destination {
    flex-wrap: wrap;
  }
  .options-fields {
    gap: 12px;
  }
}
@keyframes translation-narrow-camera {
  0%,25% {
    transform: translate(var(--input-x),-106px);
  }
  39%,100% {
    transform: translate(var(--output-x),-106px);
  }
}
html:has(#docs-pause-motion:checked) .stage-translate .translation-canvas {
  transform: translate(0,-106px);
}
@container(max-width:718px) {
  html:has(#docs-pause-motion:checked) .stage-translate .translation-canvas {
    transform: translate(var(--output-x),-106px);
  }
}
@media(prefers-reduced-motion:reduce) {
  .stage-translate .translation-canvas {
    animation: none!important;
  }
}
</style>
