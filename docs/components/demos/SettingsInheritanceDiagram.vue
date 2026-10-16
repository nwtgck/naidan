<script setup lang="ts">

const { messages } = defineProps<{ messages: typeof import('../../pages/settings-inheritance/messages/en').messages }>();
const answerChunks = { park: messages.answers_park(), movie: messages.answers_movie(), museum: messages.answers_museum() };

type Scope = 'chat' | 'group' | 'global';
type Phase = {
  id: 'ungrouped' | 'groupUnset' | 'groupModel' | 'chatModel';
  chat: 'unset' | 'set';
  group: 'outside' | 'unset' | 'set';
  checked: readonly Scope[];
  chosen: Scope;
  answer: 'park' | 'movie' | 'museum';
};

const scopes = ['chat', 'group', 'global'] as const satisfies readonly Scope[];
const phases: readonly Phase[] = [
  { id: 'ungrouped', chat: 'unset', group: 'outside', checked: ['chat', 'global'], chosen: 'global', answer: 'park' },
  { id: 'groupUnset', chat: 'unset', group: 'unset', checked: ['chat', 'group', 'global'], chosen: 'global', answer: 'park' },
  { id: 'groupModel', chat: 'unset', group: 'set', checked: ['chat', 'group'], chosen: 'group', answer: 'movie' },
  { id: 'chatModel', chat: 'set', group: 'set', checked: ['chat'], chosen: 'chat', answer: 'museum' },
];

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <div class="inheritance-diagram" data-docs-animation="inheritance-concept" data-testid="inheritance-concept" aria-hidden="true">
    <div v-for="phase in phases" :key="phase.id" class="phase" :class="`phase-${phase.id}`" :data-testid="`inheritance-concept-${phase.id}`">
      <div class="phase-title">{{ (phase.id === 'ungrouped' ? messages.ungrouped_model_choice_heading : phase.id === 'groupUnset' ? messages.unset_group_model_choice_heading : phase.id === 'groupModel' ? messages.group_model_choice_heading : messages.chat_model_choice_heading) }}</div>
      <div class="question-card"><span class="eyebrow">{{ messages.message_sent }}</span><strong>{{ messages.suggest_one_thing_to_do_this_weekend }}</strong></div>
      <div class="lookup-label">{{ messages.check_model_settings }}</div>
      <div class="lookup-route">
        <template v-for="(scope, index) in scopes" :key="scope">
          <span v-if="index > 0" class="route-arrow" aria-hidden="true">→</span>
          <div class="scope" :class="{ 'scope-chosen': scope === phase.chosen, 'scope-unchecked': !phase.checked.includes(scope), 'scope-outside': scope === 'group' && phase.group === 'outside' }" :data-slot="scope" :data-checked="phase.checked.includes(scope)" :data-selected="scope === phase.chosen" :data-testid="`inheritance-scope-${phase.id}-${scope}`">
            <span class="scope-title">{{ (scope === 'chat' ? messages.this_chat : scope === 'group' ? messages.chat_group : messages.global_scope) }}</span>
            <strong class="scope-value">{{ scope === 'chat' ? (phase.chat === 'set' ? messages.chat_example_model : messages.no_model_set) : scope === 'group' ? (phase.group === 'outside' ? messages.no_group : phase.group === 'set' ? messages.group_example_model : messages.no_model_set) : messages.global_example_model }}</strong>
            <small v-if="!phase.checked.includes(scope) && !(scope === 'group' && phase.group === 'outside')" class="scope-note">{{ messages.no_need_to_check }}</small>
          </div>
        </template>
      </div>
      <div class="result" :data-testid="`inheritance-result-${phase.id}`">
        <div class="chosen-model"><span class="eyebrow">{{ messages.model_chosen }}</span><strong>{{ (phase.chosen === 'chat' ? messages.chat_example_model : phase.chosen === 'group' ? messages.group_example_model : messages.global_example_model) }}</strong><small>{{ (phase.chosen === 'chat' ? messages.from_this_chat : phase.chosen === 'group' ? messages.from_group : messages.from_global) }}</small></div>
        <div class="example-answer"><span class="eyebrow">{{ messages.example_reply }}</span><p><span class="answer-first">{{ answerChunks[phase.answer][0] }}</span><span class="answer-second">{{ answerChunks[phase.answer][1] }}</span></p></div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.inheritance-diagram {
  display: grid;
  width: 100%;
  max-width: 680px;
  margin-inline: auto;
  overflow: hidden;
  container-type: inline-size;
  border: 1px solid var(--line-strong);
  border-radius: 16px;
  background: var(--surface);
  box-shadow: var(--panel-shadow);
  color: var(--text);
}
.phase {
  grid-area: 1/1;
  display: grid;
  align-content: start;
  gap: 9px;
  padding: 16px;
  opacity: 0;
  visibility: hidden;
  animation-duration: 20s;
  animation-timing-function: linear;
  animation-iteration-count: infinite;
}
.phase-ungrouped {
  opacity: 1;
  visibility: visible;
  animation-name: show-ungrouped;
}
.phase-groupUnset {
  animation-name: show-group-unset;
}
.phase-groupModel {
  animation-name: show-group-model;
}
.phase-chatModel {
  animation-name: show-chat-model;
}
.phase-title {
  min-height: 30px;
  padding: 5px 10px;
  border-radius: 9px;
  background: color-mix(in srgb,var(--blue) 11%,var(--surface));
  color: var(--blue);
  font-size: 13px;
  font-weight: 800;
  line-height: 1.4;
}
.question-card {
  display: grid;
  gap: 2px;
  padding: 8px 11px;
  border: 1px solid var(--line-strong);
  border-radius: 10px;
  background: var(--surface-2);
  animation: send-question 5s linear infinite;
}
.question-card strong {
  font-size: 13px;
  line-height: 1.5;
}
.eyebrow,.lookup-label {
  color: var(--muted);
  font-size: 10px;
  font-weight: 800;
  letter-spacing: .04em;
  line-height: 1.4;
}
.lookup-label {
  margin-top: 2px;
}
.lookup-route {
  display: grid;
  grid-template-columns: minmax(0,1fr) 14px minmax(0,1fr) 14px minmax(0,1fr);
  align-items: center;
  gap: 5px;
}
.route-arrow {
  color: var(--blue);
  font-size: 16px;
  font-weight: 900;
  text-align: center;
}
.scope {
  position: relative;
  display: grid;
  align-content: start;
  gap: 3px;
  min-width: 0;
  min-height: 91px;
  padding: 8px 9px;
  border: 1px solid var(--line-strong);
  border-radius: 10px;
  background: var(--surface-2);
}
.scope::after {
  content: '';
  position: absolute;
  inset: -2px;
  border: 2px solid var(--blue);
  border-radius: 11px;
  opacity: 0;
  pointer-events: none;
}
.scope[data-checked="true"][data-slot="chat"]::after {
  animation: scan-chat 5s linear infinite;
}
.scope[data-checked="true"][data-slot="group"]::after {
  animation: scan-group 5s linear infinite;
}
.scope[data-checked="true"][data-slot="global"]::after {
  animation: scan-global 5s linear infinite;
}
.scope-title {
  color: var(--muted);
  font-size: 10px;
  font-weight: 800;
  line-height: 1.3;
}
.scope-value {
  min-width: 0;
  font-size: 12px;
  line-height: 1.4;
  overflow-wrap: anywhere;
}
.scope-note {
  color: var(--muted);
  font-size: 9px;
  line-height: 1.3;
}
.scope-unchecked {
  opacity: .58;
}
.scope-outside {
  border-style: dashed;
}
.scope-chosen {
  animation: choose-scope 5s linear infinite;
}
.result {
  display: grid;
  grid-template-columns: minmax(0,1fr) minmax(0,1.5fr);
  gap: 10px;
  margin-top: 3px;
  opacity: 0;
  animation: show-result 5s linear infinite;
}
.chosen-model,.example-answer {
  display: grid;
  align-content: start;
  gap: 3px;
  min-width: 0;
  min-height: 73px;
  padding: 8px 11px;
  border: 1px solid var(--line-strong);
  border-radius: 10px;
  background: var(--surface-2);
}
.chosen-model {
  border-color: var(--blue);
  background: color-mix(in srgb,var(--blue) 7%,var(--surface));
}
.chosen-model strong {
  font-size: 13px;
  overflow-wrap: anywhere;
}
.chosen-model small {
  color: var(--blue);
  font-size: 10px;
  font-weight: 800;
}
.example-answer p {
  margin: 0;
  font-size: 12px;
  line-height: 1.5;
  overflow-wrap: anywhere;
}
.answer-first,.answer-second {
  opacity: 0;
}
.answer-first {
  animation: show-first-chunk 5s linear infinite;
}
.answer-second {
  animation: show-second-chunk 5s linear infinite;
}
@keyframes show-ungrouped {
  0%,24% {
    opacity: 1;
    visibility: visible;
  }
  25%,100% {
    opacity: 0;
    visibility: hidden;
  }
}
@keyframes show-group-unset {
  0%,24% {
    opacity: 0;
    visibility: hidden;
  }
  25%,49% {
    opacity: 1;
    visibility: visible;
  }
  50%,100% {
    opacity: 0;
    visibility: hidden;
  }
}
@keyframes show-group-model {
  0%,49% {
    opacity: 0;
    visibility: hidden;
  }
  50%,74% {
    opacity: 1;
    visibility: visible;
  }
  75%,100% {
    opacity: 0;
    visibility: hidden;
  }
}
@keyframes show-chat-model {
  0%,74% {
    opacity: 0;
    visibility: hidden;
  }
  75%,100% {
    opacity: 1;
    visibility: visible;
  }
}
@keyframes send-question {
  0%,6% {
    opacity: 0;
    transform: translateY(-5px);
  }
  14%,100% {
    opacity: 1;
    transform: none;
  }
}
@keyframes scan-chat {
  0%,12%,27%,100% {
    opacity: 0;
  }
  16%,23% {
    opacity: 1;
  }
}
@keyframes scan-group {
  0%,30%,45%,100% {
    opacity: 0;
  }
  34%,41% {
    opacity: 1;
  }
}
@keyframes scan-global {
  0%,48%,63%,100% {
    opacity: 0;
  }
  52%,59% {
    opacity: 1;
  }
}
@keyframes choose-scope {
  0%,64% {
    border-color: var(--line-strong);
    background: var(--surface-2);
  }
  70%,100% {
    border-color: var(--blue);
    background: color-mix(in srgb,var(--blue) 10%,var(--surface));
  }
}
@keyframes show-result {
  0%,63% {
    opacity: 0;
  }
  70%,100% {
    opacity: 1;
  }
}
@keyframes show-first-chunk {
  0%,68% {
    opacity: 0;
  }
  74%,100% {
    opacity: 1;
  }
}
@keyframes show-second-chunk {
  0%,78% {
    opacity: 0;
  }
  84%,100% {
    opacity: 1;
  }
}
@container (max-width:480px) {
  .phase {
    padding: 11px;
    gap: 7px;
  }
  .lookup-route {
    grid-template-columns: minmax(0,1fr);
    gap: 2px;
  }
  .route-arrow {
    font-size: 12px;
    line-height: 11px;
    transform: rotate(90deg);
  }
  .scope {
    display: grid;
    grid-template-columns: minmax(0,78px) minmax(0,1fr);
    align-items: center;
    gap: 4px 6px;
    min-height: 46px;
    padding: 6px 9px;
  }
  .scope-note {
    grid-column: 2;
  }
  .result {
    grid-template-columns: minmax(0,1fr);
    gap: 6px;
  }
  .chosen-model,.example-answer {
    min-height: 0;
    padding: 7px 9px;
  }
}
html:has(#docs-pause-motion:checked) .inheritance-diagram * {
  animation: none!important;
}
html:has(#docs-pause-motion:checked) .inheritance-diagram .phase {
  opacity: 0;
  visibility: hidden;
}
html:has(#docs-pause-motion:checked) .inheritance-diagram .phase-chatModel {
  opacity: 1;
  visibility: visible;
}
html:has(#docs-pause-motion:checked) .inheritance-diagram .question-card,html:has(#docs-pause-motion:checked) .inheritance-diagram .result,html:has(#docs-pause-motion:checked) .inheritance-diagram .answer-first,html:has(#docs-pause-motion:checked) .inheritance-diagram .answer-second {
  opacity: 1;
  transform: none;
}
html:has(#docs-pause-motion:checked) .inheritance-diagram .scope-chosen {
  border-color: var(--blue);
  background: color-mix(in srgb,var(--blue) 10%,var(--surface));
}
@media(prefers-reduced-motion:reduce) {
  .inheritance-diagram * {
    animation: none!important;
  }
  .phase {
    opacity: 0;
    visibility: hidden;
  }
  .phase-chatModel {
    opacity: 1;
    visibility: visible;
  }
  .question-card,.result,.answer-first,.answer-second {
    opacity: 1;
    transform: none;
  }
  .scope-chosen {
    border-color: var(--blue);
    background: color-mix(in srgb,var(--blue) 10%,var(--surface));
  }
}
</style>
