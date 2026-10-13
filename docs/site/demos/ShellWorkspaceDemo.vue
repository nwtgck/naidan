<script setup lang="ts">
import { computed } from 'vue';
import { BirdIcon, UserIcon, Loader2Icon, HammerIcon, CheckCircle2Icon, ChevronDownIcon, ChevronRightIcon, ChevronUpIcon, EyeIcon, EyeOffIcon, ShapesIcon, WrapTextIcon, MousePointer2Icon, TerminalIcon } from 'lucide-vue-next';
import ReplicaChrome from './ReplicaChrome.vue';
import type { ReplicaChromeCopy, ShellDemoCopy } from '../messages';

const props = defineProps<{ copy: ShellDemoCopy; chrome: ReplicaChromeCopy }>();

function formatResult({ stdout }: { stdout: string }): string {
  // Match createWeshTool's envelope, including absent STDOUT for silent commands.
  return ['Exit Code: 0', ...(stdout.length > 0 ? ['', 'STDOUT:', stdout] : []), ''].join('\n');
}

const steps = computed(() => {
  const grepOutput = props.copy.noteLines.map((line, index) => String(3 + index * 4) + ':TODO: ' + line + '\n').join('');
  const notes = ['# ' + props.copy.notesTitle, '', ...props.copy.noteLines.flatMap((line, index) => [
    'TODO: ' + line, '', ...(index === 0 ? [props.copy.reviewNote, ''] : []),
  ])].join('\n') + '\n';
  const summary = ['# ' + props.copy.summaryTitle, '', ...props.copy.noteLines.map(line => '- ' + line)].join('\n') + '\n';
  const entries = [
    {
      id: 'git',
      stage: 'stage-one',
      title: props.copy.stepTitles.git,
      summary: props.copy.sequenceSummaries.git,
      previousSummary: undefined,
      script: 'git -C /home/user/project status --short',
      stdout: '',
    },
    {
      id: 'grep',
      stage: 'stage-two',
      title: props.copy.stepTitles.grep,
      summary: props.copy.sequenceSummaries.grep,
      previousSummary: props.copy.sequenceSummaries.git,
      script: "grep -n 'TODO' /home/user/project/notes.md",
      stdout: grepOutput,
    },
    {
      id: 'sed',
      stage: 'stage-three',
      title: props.copy.stepTitles.sed,
      summary: props.copy.sequenceSummaries.sed,
      previousSummary: props.copy.sequenceSummaries.grep,
      script: "sed -n '1,8p' /home/user/project/notes.md",
      stdout: notes,
    },
    {
      id: 'write',
      stage: 'stage-four',
      title: props.copy.stepTitles.write,
      summary: props.copy.sequenceSummaries.write,
      previousSummary: props.copy.sequenceSummaries.sed,
      script: ['cat <<EOF > /home/user/project/task-summary.md', summary.trimEnd(), 'EOF', ''].join('\n'),
      stdout: '',
    },
    {
      id: 'review',
      stage: 'stage-five',
      title: props.copy.stepTitles.review,
      summary: props.copy.sequenceSummaries.review,
      previousSummary: props.copy.sequenceSummaries.write,
      script: ['cat /home/user/project/task-summary.md', 'git -C /home/user/project status --short'].join('\n'),
      stdout: summary + '?? task-summary.md\n',
    },
  ];
  return entries.map((entry, index) => ({
    ...entry,
    history: entries.slice(0, index),
    argumentsJson: JSON.stringify({ shell_script: entry.script }),
    result: formatResult({ stdout: entry.stdout }),
  }));
});

defineExpose({
  ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}),
});
</script>

<template>
  <div data-docs-animation="shell-tool-call" data-testid="docs-shell-demo" aria-hidden="true">
    <ReplicaChrome :title="copy.title" :address="copy.address" :copy="chrome" sidebar="hidden">
      <div class="shell-chat">
        <div class="shell-user">
          <div class="message-heading"><span class="message-avatar"><UserIcon :size="15" /></span><b>{{ copy.you }}</b></div>
          <p>{{ copy.prompt }}</p>
        </div>
        <div class="shell-assistant">
          <div class="message-heading"><span class="message-avatar assistant-avatar"><BirdIcon :size="15" /></span><b>{{ copy.assistant }}</b></div>
          <!-- Every scene shares a grid cell, reserving the largest intrinsic size. -->
          <div class="shell-stage-grid" data-testid="docs-shell-stages">
            <div v-for="step in steps" :key="step.id" class="stage-layer" :class="step.stage" :data-shell-step="step.id">
              <div class="draft-variant">
                <div v-if="step.previousSummary" class="previous-process">
                  <div class="process-toggle"><EyeOffIcon :size="12" /><span>{{ step.previousSummary }}</span></div>
                  <div class="tool-group">
                    <div class="tool-group-heading"><ShapesIcon :size="14" /><span>{{ copy.hideToolExecutions }}</span></div>
                    <div v-for="previous in step.history" :key="previous.id" class="history-call" data-testid="docs-shell-history"><CheckCircle2Icon :size="12" /><strong>shell_execute</strong><ChevronDownIcon :size="13" /></div>
                  </div>
                </div>
                <!-- Draft calls remain outside the completed process sequence. -->
                <div class="tool-draft" data-testid="docs-shell-draft">
                  <div class="draft-heading"><Loader2Icon class="draft-spinner" :size="14" /><div><strong>shell_execute</strong><span>{{ copy.generating }}</span></div><ChevronDownIcon :size="12" /></div>
                  <div class="draft-details">
                    <pre class="shell-command"><span class="command-prompt">$ </span><code class="draft-command">{{ step.script }}</code></pre>
                    <div class="raw-json"><ChevronRightIcon :size="12" />{{ copy.rawJson }}</div>
                  </div>
                </div>
              </div>

              <div class="execution-variant" data-testid="docs-shell-sequence">
                <div class="process-toggle"><EyeOffIcon :size="12" /><span>{{ step.summary }}</span><span class="sequence-action">{{ copy.lessDetails }}</span></div>
                <div class="tool-group">
                  <div class="tool-group-heading"><ShapesIcon :size="14" /><span>{{ copy.hideToolExecutions }}</span></div>
                  <!-- Completed call headers remain visible as the next call is added. -->
                  <div v-for="previous in step.history" :key="previous.id" class="history-call" data-testid="docs-shell-history"><CheckCircle2Icon :size="12" /><strong>shell_execute</strong><ChevronDownIcon :size="13" /></div>
                  <div class="tool-call" data-testid="docs-shell-call" data-tool-name="shell_execute" :data-shell-call="step.id" :data-tool-arguments="step.argumentsJson">
                    <div class="tool-heading">
                      <span class="tool-status-icon"><CheckCircle2Icon class="tool-complete" :size="12" /><HammerIcon class="tool-executing" :size="12" /></span>
                      <div class="tool-name"><strong>shell_execute</strong><span class="tool-executing">{{ copy.executing }}</span></div>
                      <ChevronUpIcon :size="14" />
                    </div>
                    <div class="tool-details">
                      <div class="command-block">
                        <pre class="shell-command" data-testid="docs-shell-command"><span class="command-prompt">$ </span><code>{{ step.script }}</code></pre>
                        <WrapTextIcon class="wrap-icon" :size="12" :title="copy.disableWrap" />
                      </div>
                      <div class="output-stack">
                        <pre class="shell-output tool-result" data-testid="docs-shell-result">{{ step.result }}</pre>
                        <pre v-if="step.stdout" class="shell-output live-output" data-testid="docs-shell-live-output">{{ step.stdout }}</pre>
                      </div>
                      <div class="raw-json"><ChevronRightIcon :size="12" />{{ copy.rawJson }}</div>
                    </div>
                  </div>
                </div>
              </div>

              <div v-if="step.id === 'git'" class="initial-summary">
                <div class="process-toggle"><EyeIcon :size="12" /><span>{{ step.summary }}</span><span class="sequence-action">{{ copy.showDetails }}</span></div>
                <MousePointer2Icon class="demo-pointer" :size="19" />
              </div>
            </div>
          </div>
          <div class="shell-response" data-testid="docs-shell-response">
            <p>{{ copy.responseLead }}</p>
            <ul><li v-for="item in copy.responseItems" :key="item">{{ item }}</li></ul>
          </div>
        </div>
      </div>
    </ReplicaChrome>
  </div>
  <details class="shell-transcript" data-testid="docs-shell-transcript">
    <summary>
      <span class="transcript-icon"><TerminalIcon :size="16" aria-hidden="true" /></span>
      <strong>{{ copy.transcriptTitle }}</strong>
      <span class="transcript-count">{{ copy.transcriptCount }}</span>
      <ChevronRightIcon class="transcript-chevron" :size="17" aria-hidden="true" />
    </summary>
    <div class="transcript-body">
      <p class="transcript-intro">{{ copy.transcriptIntro }}</p>
      <div class="transcript-message"><b>{{ copy.you }}</b><p>{{ copy.prompt }}</p></div>
      <section v-for="(step, index) in steps" :key="step.id" class="transcript-step">
        <div class="transcript-step-heading"><span aria-hidden="true">{{ index + 1 }}</span><h3>{{ step.title }}</h3></div>
        <div class="transcript-panels">
          <div class="transcript-panel"><div class="transcript-panel-label"><TerminalIcon :size="13" aria-hidden="true" />{{ copy.transcriptCommand }}</div><pre><code>{{ step.script }}</code></pre></div>
          <div class="transcript-panel transcript-result"><div class="transcript-panel-label"><CheckCircle2Icon :size="13" aria-hidden="true" />{{ copy.transcriptResult }}</div><pre>{{ step.result }}</pre></div>
        </div>
      </section>
      <div class="transcript-message transcript-answer"><b>{{ copy.assistant }}</b><p>{{ copy.responseLead }}</p><ul><li v-for="item in copy.responseItems" :key="item">{{ item }}</li></ul></div>
    </div>
  </details>
</template>

<style scoped>
.shell-chat {
  --shell-cycle: 30s;
  min-width: 0;
  overflow-wrap: anywhere;
  font-size: 12px;
  line-height: 1.7;
}
.shell-user,.shell-assistant {
  padding: 13px 16px;
}
.shell-user p,.shell-response p {
  margin: 9px 0 0;
  font: inherit;
  color: #e5e7eb;
}
.shell-assistant {
  border-top: 1px solid #1f293780;
  background: #1f293733;
  padding-bottom: 16px;
}
.message-heading {
  display: flex;
  align-items: center;
  gap: 9px;
  margin-bottom: 8px;
}
.message-heading b {
  min-width: 0;
  font-size: 10px;
  color: #9ca3af;
}
.shell-user .message-heading b {
  text-transform: uppercase;
  letter-spacing: .1em;
  color: #e5e7eb;
}
.message-avatar {
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 26px;
  height: 26px;
  border-radius: 9px;
  border: 1px solid #374151;
  background: #1f2937;
  color: #6b7280;
}
.assistant-avatar {
  color: #60a5fa;
}
.shell-stage-grid,.stage-layer {
  display: grid;
  min-width: 0;
}
.shell-stage-grid,.shell-response {
  animation: shell-scene-replay var(--shell-cycle) linear infinite both;
}
.stage-layer {
  grid-area: 1/1;
  align-content: start;
  opacity: 0;
  visibility: hidden;
  animation-duration: var(--shell-cycle);
  animation-timing-function: linear;
  animation-iteration-count: infinite;
  animation-fill-mode: both;
}
.stage-one {
  --step-delay: 0s;
  animation-name: shell-stage-one;
}
.stage-two {
  --step-delay: 4.8s;
  animation-name: shell-stage-two;
}
.stage-three {
  --step-delay: 9.6s;
  animation-name: shell-stage-three;
}
.stage-four {
  --step-delay: 14.4s;
  animation-name: shell-stage-four;
}
.stage-five {
  --step-delay: 19.2s;
  animation-name: shell-stage-five;
  opacity: 1;
  visibility: visible;
}
.draft-variant,.execution-variant,.initial-summary {
  grid-area: 1/1;
  min-width: 0;
  align-self: start;
}
.draft-variant {
  opacity: 0;
  visibility: hidden;
  animation: shell-draft var(--shell-cycle) linear var(--step-delay) infinite both;
}
.execution-variant {
  animation: shell-execution var(--shell-cycle) linear var(--step-delay) infinite both;
}
.initial-summary {
  position: relative;
  opacity: 0;
  visibility: hidden;
  animation: shell-initial-summary var(--shell-cycle) linear infinite both;
}
.previous-process {
  margin-bottom: 10px;
}
.tool-draft {
  border: 1px solid #1e40af4d;
  border-radius: 12px;
  background: #1f29374d;
}
.draft-heading {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  color: #9ca3af;
}
.draft-heading div {
  flex: 1;
  min-width: 0;
}
.draft-heading strong,.draft-heading span {
  display: block;
  font-size: 10px;
}
.draft-heading strong {
  color: #e5e7eb;
  font-weight: 600;
}
.draft-heading span {
  font-size: 9px;
}
.draft-spinner {
  color: #60a5fa;
  animation: shell-spin 1.5s linear infinite;
}
.draft-details {
  padding: 0 12px 12px;
}
.draft-command {
  display: inline-block;
  max-width: calc(100% - 14px);
  vertical-align: top;
  animation: shell-script var(--shell-cycle) steps(38,end) var(--step-delay) infinite both;
}
.process-toggle {
  box-sizing: border-box;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  max-width: 100%;
  padding: 4px 9px;
  border: 1px solid #1e40af99;
  border-radius: 8px;
  background: #1e3a8a4d;
  color: #93c5fd;
  font-size: 10px;
  font-weight: 700;
}
.process-toggle > span {
  min-width: 0;
  overflow-wrap: anywhere;
}
.process-toggle > svg {
  flex-shrink: 0;
}
.initial-summary .process-toggle {
  border-color: #374151;
  background: #1f2937;
  color: #6b7280;
}
.sequence-action {
  flex-shrink: 0;
  border-left: 1px solid #93c5fd26;
  padding-left: 7px;
  text-transform: uppercase;
  font-size: 8px;
  opacity: 0;
}
.initial-summary .sequence-action {
  opacity: 1;
}
.tool-group {
  margin-top: 9px;
  padding: 10px;
  border: 1px solid #1e40af4d;
  border-radius: 16px;
  background: linear-gradient(135deg,#17255433,#082f4933);
}
.tool-group-heading {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
  color: #60a5fa;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: .025em;
}
.tool-group-heading span {
  min-width: 0;
}
.draft-heading > svg,.tool-group-heading > svg,.raw-json > svg {
  flex-shrink: 0;
}
.history-call {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 6px 10px;
  margin-bottom: 6px;
  border: 1px solid #3741514d;
  border-radius: 10px;
  color: #9ca3af;
  font-size: 10px;
}
.history-call strong {
  min-width: 0;
  text-transform: capitalize;
}
.history-call > svg {
  flex-shrink: 0;
}
.history-call > svg:last-child {
  margin-left: auto;
}
.tool-call {
  min-width: 0;
  border: 1px solid #3741514d;
  border-radius: 12px;
  background: #1f29374d;
}
.tool-heading {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 10px;
  color: #9ca3af;
}
.tool-heading > svg {
  margin-left: auto;
  flex-shrink: 0;
}
.tool-status-icon {
  display: grid;
  flex-shrink: 0;
  border-radius: 7px;
  padding: 4px;
  background: #37415180;
}
.tool-status-icon svg {
  grid-area: 1/1;
}
.tool-name {
  display: grid;
  min-width: 0;
}
.tool-name strong {
  font-size: 10px;
  letter-spacing: .05em;
  text-transform: capitalize;
}
.tool-name span {
  font-size: 9px;
  color: #60a5fab3;
}
.tool-executing {
  opacity: 0;
  visibility: hidden;
  animation: shell-running var(--shell-cycle) linear var(--step-delay) infinite both;
}
.tool-complete,.tool-result {
  animation: shell-result var(--shell-cycle) linear var(--step-delay) infinite both;
}
.tool-status-icon .tool-executing {
  color: #60a5fa;
}
.tool-details {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px;
  border-top: 1px solid #3741514d;
}
.command-block {
  position: relative;
  min-width: 0;
}
.shell-command,.shell-output {
  box-sizing: border-box;
  min-width: 0;
  max-width: 100%;
  margin: 0;
  padding: 8px;
  border: 0;
  border-radius: 8px;
  font: 10px/1.6 ui-monospace,monospace;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  overflow-x: auto;
  text-align: left;
  color: #d1d5db;
}
.shell-command {
  background: #0003;
}
.shell-command code {
  font: inherit;
  white-space: inherit;
  overflow-wrap: inherit;
}
.command-prompt {
  color: #60a5fa80;
}
.wrap-icon {
  position: absolute;
  top: 5px;
  right: 5px;
  color: #60a5fab3;
  opacity: 0;
}
.output-stack {
  display: grid;
  min-width: 0;
}
.output-stack > pre {
  grid-area: 1/1;
}
.tool-result {
  background: #22c55e0d;
}
.live-output {
  opacity: 0;
  visibility: hidden;
  background: #3b82f60d;
  animation: shell-running var(--shell-cycle) linear var(--step-delay) infinite both;
}
.stage-one .execution-variant {
  animation-name: shell-first-execution;
}
.stage-one .tool-complete,.stage-one .tool-result {
  animation-name: shell-first-result;
}
.stage-one .tool-executing,.stage-one .live-output {
  animation-name: shell-first-running;
}
.raw-json {
  display: flex;
  align-items: center;
  gap: 4px;
  color: #9ca3af;
  font-size: 9px;
  font-weight: 700;
  text-transform: uppercase;
}
.draft-details .raw-json {
  margin-top: 8px;
}
.demo-pointer {
  position: absolute;
  top: 16px;
  left: clamp(80px,40%,190px);
  color: #e5e7eb;
  fill: #111827;
  pointer-events: none;
  animation: shell-pointer var(--shell-cycle) ease-in-out infinite both;
}
.shell-response {
  animation: shell-response var(--shell-cycle) linear infinite both;
}
.shell-response ul {
  margin: 8px 0 0;
  padding-left: 21px;
  font: inherit;
  color: #e5e7eb;
}
.shell-response li {
  color: inherit;
  line-height: inherit;
}
.shell-transcript {
  min-width: 0;
  margin-top: 16px;
  border: 1px solid var(--line-strong);
  border-radius: 13px;
  background: var(--surface);
  overflow-wrap: anywhere;
}
.shell-transcript summary {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 14px;
  border-radius: 12px;
  background: var(--surface-2);
  color: var(--text);
  cursor: pointer;
  list-style: none;
  font-size: 13px;
  line-height: 1.55;
}
.shell-transcript summary::-webkit-details-marker {
  display: none;
}
.shell-transcript summary::marker {
  content: '';
}
.shell-transcript summary:hover {
  background: var(--surface-3);
}
.shell-transcript summary:focus-visible {
  outline: 2px solid var(--blue);
  outline-offset: 3px;
}
.shell-transcript summary strong {
  flex: 1;
  min-width: 0;
  font-weight: 650;
}
.transcript-icon {
  display: grid;
  place-items: center;
  flex-shrink: 0;
  width: 29px;
  height: 29px;
  border: 1px solid var(--line-strong);
  border-radius: 8px;
  color: var(--blue);
  background: var(--surface);
}
.transcript-count {
  flex-shrink: 0;
  padding: 3px 7px;
  border: 1px solid var(--line);
  border-radius: 6px;
  color: var(--muted);
  background: var(--surface);
  font-size: 10px;
}
.transcript-chevron {
  flex-shrink: 0;
  color: var(--subtle);
  transition: transform .15s ease;
}
.shell-transcript[open] > summary {
  border-bottom: 1px solid var(--line);
  border-bottom-left-radius: 0;
  border-bottom-right-radius: 0;
}
.shell-transcript[open] .transcript-chevron {
  color: var(--blue);
  transform: rotate(90deg);
}
.transcript-body {
  min-width: 0;
  padding: 16px;
}
.transcript-intro {
  margin-bottom: 14px;
  font-size: 12px;
  line-height: 1.85;
}
.transcript-message {
  min-width: 0;
  padding: 11px 13px;
  border-left: 2px solid var(--blue);
  border-radius: 8px;
  background: var(--surface-2);
}
.transcript-message b {
  color: var(--blue);
  font-size: 10px;
  letter-spacing: .04em;
}
.transcript-message p,.transcript-message li {
  font-size: 13px;
  line-height: 1.8;
}
.transcript-message p {
  margin: 4px 0 0;
}
.transcript-message ul {
  margin: 7px 0 0;
  padding-left: 20px;
}
.transcript-step {
  min-width: 0;
  margin-top: 18px;
}
.transcript-step-heading {
  display: flex;
  align-items: center;
  gap: 9px;
  margin-bottom: 9px;
}
.transcript-step-heading > span {
  display: grid;
  place-items: center;
  flex-shrink: 0;
  width: 23px;
  height: 23px;
  border: 1px solid var(--line-strong);
  border-radius: 7px;
  color: var(--blue);
  background: var(--surface-2);
  font: 11px/1 ui-monospace,monospace;
}
.shell-transcript h3 {
  min-width: 0;
  margin: 0;
  color: var(--text);
  font-size: 13px;
  line-height: 1.6;
}
.transcript-panels {
  display: grid;
  grid-template-columns: minmax(0,1fr) minmax(0,1fr);
  gap: 9px;
}
.transcript-panel {
  min-width: 0;
  border: 1px solid var(--line);
  border-radius: 9px;
  background: var(--surface);
}
.transcript-panel-label {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 7px 10px;
  border-bottom: 1px solid var(--line);
  border-radius: 8px 8px 0 0;
  color: var(--muted);
  background: var(--surface-2);
  font-size: 10px;
  font-weight: 650;
}
.transcript-panel-label svg {
  flex-shrink: 0;
  color: var(--blue);
}
.transcript-result .transcript-panel-label svg {
  color: var(--green);
}
.shell-transcript pre {
  box-sizing: border-box;
  max-width: 100%;
  margin: 0;
  padding: 10px;
  border: 0;
  border-radius: 0 0 8px 8px;
  color: var(--text);
  background: var(--surface);
  font: 11px/1.7 ui-monospace,monospace;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.shell-transcript pre code {
  font: inherit;
  white-space: inherit;
  overflow-wrap: inherit;
}
.transcript-answer {
  margin-top: 18px;
}

/* Only visibility, paint and transforms change; all variants retain their grid size. */
@keyframes shell-stage-one {
  0%,15.9% { opacity: 1; visibility: visible; }
  16%,100% { opacity: 0; visibility: hidden; }
}
@keyframes shell-stage-two {
  0%,15.9%,32%,100% { opacity: 0; visibility: hidden; }
  16%,31.9% { opacity: 1; visibility: visible; }
}
@keyframes shell-stage-three {
  0%,31.9%,48%,100% { opacity: 0; visibility: hidden; }
  32%,47.9% { opacity: 1; visibility: visible; }
}
@keyframes shell-stage-four {
  0%,47.9%,64%,100% { opacity: 0; visibility: hidden; }
  48%,63.9% { opacity: 1; visibility: visible; }
}
@keyframes shell-stage-five {
  0%,63.9% { opacity: 0; visibility: hidden; }
  64%,100% { opacity: 1; visibility: visible; }
}
@keyframes shell-draft {
  0%,2% { opacity: 1; visibility: visible; }
  3%,100% { opacity: 0; visibility: hidden; }
}
@keyframes shell-script {
  0% { clip-path: inset(0 100% 0 0); }
  2%,100% { clip-path: inset(0); }
}
@keyframes shell-execution {
  0%,2% { opacity: 0; visibility: hidden; }
  3%,100% { opacity: 1; visibility: visible; }
}
@keyframes shell-first-execution {
  0%,6% { opacity: 0; visibility: hidden; }
  7%,100% { opacity: 1; visibility: visible; }
}
@keyframes shell-initial-summary {
  0%,2%,7%,100% { opacity: 0; visibility: hidden; }
  3%,6% { opacity: 1; visibility: visible; }
}
@keyframes shell-running {
  0%,2%,5%,100% { opacity: 0; visibility: hidden; }
  3%,4.9% { opacity: 1; visibility: visible; }
}
@keyframes shell-first-running {
  0%,6%,8%,100% { opacity: 0; visibility: hidden; }
  7%,7.9% { opacity: 1; visibility: visible; }
}
@keyframes shell-result {
  0%,4.9% { opacity: 0; }
  5%,100% { opacity: 1; }
}
@keyframes shell-first-result {
  0%,7.9% { opacity: 0; }
  8%,100% { opacity: 1; }
}
@keyframes shell-pointer {
  0%,3% { opacity: 0; transform: translate(25px,15px); }
  4%,5% { opacity: 1; transform: translate(0,0); }
  6% { opacity: 1; transform: translate(0,0) scale(.85); }
  7%,100% { opacity: 0; transform: translate(0,0); }
}
@keyframes shell-response {
  0%,72% { opacity: 0; }
  75%,96% { opacity: 1; }
  99%,100% { opacity: 0; }
}
@keyframes shell-scene-replay {
  0%,99%,100% { opacity: 0; }
  1%,96% { opacity: 1; }
}
@keyframes shell-spin {
  to { transform: rotate(360deg); }
}
@media(max-width:620px) {
  .shell-user,.shell-assistant { padding: 12px; }
  .shell-chat { font-size: 11px; }
  .tool-group { padding: 8px; }
  .tool-details { padding: 8px; }
  .process-toggle { gap: 6px; padding-inline: 7px; }
  .sequence-action { display: none; }
  .shell-transcript summary { gap: 8px; padding: 11px; }
  .transcript-body { padding: 12px; }
  .transcript-panels { grid-template-columns: minmax(0,1fr); }
}
</style>
