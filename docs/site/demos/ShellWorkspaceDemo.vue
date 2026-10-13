<script setup lang="ts">
import ReplicaChrome from './ReplicaChrome.vue';
import { TerminalIcon, FolderIcon, FileTextIcon, LockKeyholeIcon } from 'lucide-vue-next';

const command = 'ls /sys/fs/naidan/current-chat';
const output = `\
metadata.md     metadata.json
content-md      content-json
branches`;


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
  <div data-docs-animation="shell-read" aria-hidden="true">
    <ReplicaChrome title="Project notes" address="Naidan / Shell" sidebar="hidden">
      <div class="shell-workspace">
        <div class="shell-tree"><div class="shell-location"><FolderIcon :size="13" />/sys/fs/naidan</div><div class="shell-current"><FolderIcon :size="13" />current-chat</div><div class="shell-file"><FileTextIcon :size="12" />metadata.md</div><div class="shell-file"><FileTextIcon :size="12" />metadata.json</div><div class="shell-file"><FolderIcon :size="12" />branches</div><div class="shell-read-only"><LockKeyholeIcon :size="12" />READ ONLY</div></div>
        <div class="shell-terminal"><div class="shell-tab"><TerminalIcon :size="13" /><b>Shell</b><span>×</span></div><div class="terminal-screen"><div class="terminal-prompt"><span>$</span><code>{{ command }}</code></div><pre>{{ output }}</pre><div class="terminal-ready"><span>$</span><i /></div></div><div class="shell-status"><span class="shell-dot" /><span>Browser session</span><span>Current chat only</span></div></div>
      </div>
    </ReplicaChrome>
  </div>
</template>

<style scoped>
.shell-workspace {
  display: grid;
  grid-template-columns: 175px minmax(0,1fr);
  flex: 1;
  min-height: 255px;
  font: 11px/1.8 ui-monospace,monospace;
}

.shell-tree {
  padding: 18px 10px;
  background: #162031;
  border-right: 1px solid #29374c;
  color: #a7b5c9;
}

.shell-location,.shell-current,.shell-file {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 6px;
}

.shell-location {
  font-size: 10px;
  color: #c8d4e4;
}

.shell-current {
  background: #253754;
  border-radius: 5px;
  color: #93c5fd;
  margin: 6px 0;
}

.shell-file {
  padding-left: 17px;
  font-size: 10px;
}

.shell-read-only {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 21px 6px 0;
  color: #8ed8b5;
  font-size: 9px;
  letter-spacing: .04em;
}

.shell-terminal {
  display: flex;
  flex-direction: column;
  min-width: 0;
  background: #0d1522;
}

.shell-tab {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 10px 14px;
  border-bottom: 1px solid #29374c;
  font: 11px/1.6 ui-sans-serif,system-ui,sans-serif;
  color: #afc0d7;
}

.shell-tab b {
  font-weight: 500;
}

.shell-tab span {
  margin-left: auto;
  color: #627794;
}

.terminal-screen {
  padding: 22px 17px;
  flex: 1;
}

.terminal-prompt {
  display: flex;
  align-items: baseline;
  gap: 7px;
  min-width: 0;
}

.terminal-prompt span,.terminal-ready span {
  color: #91d9b7;
}

.terminal-prompt code {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  color: #e2eaf6;
  clip-path: inset(0);
  animation: docs-command 11s steps(30,end) infinite;
}

.terminal-screen pre {
  background: transparent;
  border: 0;
  border-radius: 0;
  padding: 0;
  white-space: pre-wrap;
  color: #a0b9da;
  font: inherit;
  margin: 15px 0;
  animation: docs-terminal-response 11s ease-in-out infinite;
}

.terminal-ready {
  display: flex;
  gap: 8px;
  align-items: center;
  color: #91d9b7;
}

.terminal-ready i {
  width: 7px;
  height: 13px;
  background: #91d9b7;
  animation: docs-terminal-cursor 2s steps(1,end) infinite;
}

.shell-status {
  display: flex;
  align-items: center;
  gap: 6px;
  border-top: 1px solid #29374c;
  padding: 8px 12px;
  color: #8096b4;
  font-size: 9px;
}

.shell-status span:last-child {
  margin-left: auto;
}

.shell-dot {
  width: 4px;
  height: 4px;
  border-radius: 100%;
  background: #91d9b7;
}

@keyframes docs-command {
  0%,8% {
    clip-path: inset(0 100% 0 0);
  }
  38%,100% {
    clip-path: inset(0);
  }
}

@keyframes docs-terminal-response {
  0%,32% {
    opacity: .15;
  }
  42%,100% {
    opacity: 1;
  }
}

@keyframes docs-terminal-cursor {
  0%,65% {
    opacity: 1;
  }
  66%,100% {
    opacity: .3;
  }
}

@media(max-width:620px) {
  .shell-workspace {
    grid-template-columns: 1fr;
  }
  .shell-tree {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    padding: 12px;
    border-right: 0;
    border-bottom: 1px solid #29374c;
  }
  .shell-current {
    margin: 0;
  }
  .shell-file {
    padding-left: 6px;
  }
  .shell-read-only {
    padding: 6px;
  }
  .terminal-screen {
    padding: 18px 13px;
    min-height: 170px;
  }
}
</style>
