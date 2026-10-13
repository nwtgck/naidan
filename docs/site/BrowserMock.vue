<script setup lang="ts">
import { PaperclipIcon, SendIcon, ChevronDownIcon, CopyIcon, PencilIcon, GitForkIcon, RefreshCwIcon } from 'lucide-vue-next';
import logo from '../assets/naidan.svg';
import ReplicaChrome from './demos/ReplicaChrome.vue';

// Copy the visual composition, not the application runtime. No model, account,
// file handles, clipboard operations or network connections are created here.


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
  <div class="home-demonstration" data-docs-animation="chat-response" aria-hidden="true">
    <ReplicaChrome title="Project summary" address="Naidan" sidebar="visible">
      <div class="demo-thread">
        <div class="demo-user"><span class="demo-role">YOU</span><p>Summarize the notes for tomorrow.</p><span class="demo-file"><PaperclipIcon :size="11" /> notes.txt</span></div>
        <div class="demo-assistant"><img :src="logo" width="23" height="23" alt=""><div><b>Naidan</b><div class="demo-answer"><p>Here is the plan:</p><ul><li>Review the prototype.</li><li>Check the remaining tasks.</li><li>Prepare the next iteration.</li></ul></div><div class="demo-message-actions"><CopyIcon :size="12" /><PencilIcon :size="12" /><RefreshCwIcon :size="12" /><GitForkIcon :size="12" /></div></div></div>
      </div>
      <div class="demo-input"><div class="demo-placeholder">Type a message...</div><div class="demo-input-controls"><span class="demo-model">Gemma <ChevronDownIcon :size="10" /></span><PaperclipIcon :size="13" /><span class="demo-send"><SendIcon :size="13" /></span></div></div>
    </ReplicaChrome>
    <div class="demo-capabilities"><span>Text generation</span><span>Image generation</span><span>Speech generation</span></div>
  </div>
</template>

<style scoped>
.home-demonstration {
  position: relative;
  min-width: 0;
}

.demo-thread {
  padding: 19px 19px 14px;
  flex: 1;
  font: 11px/1.8 ui-sans-serif, system-ui, sans-serif;
}

.demo-user {
  margin-left: auto;
  width: fit-content;
  max-width: 96%;
  border: 1px solid #374151;
  background: #1f2937;
  padding: 12px 15px;
  border-radius: 15px 15px 4px 15px;
}

.demo-role {
  color: #8b9bb1;
  font-size: 8px;
  font-weight: 700;
  letter-spacing: .1em;
}

.demo-user p {
  margin: 4px 0 8px;
  color: #e5e7eb;
}

.demo-file {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  background: #111827;
  border: 1px solid #364152;
  border-radius: 5px;
  padding: 1px 5px;
  color: #93c5fd;
  font-size: 9px;
}

.demo-assistant {
  display: flex;
  gap: 10px;
  margin-top: 24px;
}

.demo-assistant img {
  flex-shrink: 0;
  margin-top: 2px;
}

.demo-assistant b {
  display: block;
  color: #e5e7eb;
  font-size: 10px;
}

.demo-answer {
  color: #cad5e5;
  clip-path: inset(0 0 0 0);
  animation: docs-response-reveal 12s ease-in-out infinite;
}

.demo-answer p {
  margin: 5px 0;
}

.demo-answer ul {
  padding-left: 14px;
  margin: 0;
}

.demo-message-actions {
  display: flex;
  gap: 12px;
  margin-top: 10px;
  color: #9ca3af;
}

.demo-input {
  background: #1f2937;
  border: 1px solid #374151;
  border-radius: 12px;
  margin: 10px 12px 14px;
  padding: 12px;
}

.demo-placeholder {
  color: #8492a6;
  font: 10px/1.6 ui-sans-serif, system-ui, sans-serif;
  padding-bottom: 14px;
}

.demo-input-controls {
  display: flex;
  align-items: center;
  gap: 10px;
  color: #a3b2c9;
}

.demo-model {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 9px;
  margin-right: auto;
}

.demo-send {
  display: flex;
  align-items: center;
  padding: 8px 10px;
  background: #2563eb;
  color: white;
  border-radius: 8px;
}

.demo-capabilities {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 14px;
  font: 10px/1.4 ui-sans-serif, system-ui, sans-serif;
  color: var(--muted);
}

.demo-capabilities span {
  border: 1px solid var(--line-strong);
  border-radius: 6px;
  padding: 5px 8px;
}

@keyframes docs-response-reveal {
  0%,8% {
    clip-path: inset(0 0 100% 0);
  }
  42%,94% {
    clip-path: inset(0 0 0 0);
  }
  100% {
    clip-path: inset(0 0 100% 0);
  }
}

@media(max-width:600px) {
  .demo-thread {
    font-size: 9px;
    padding: 15px 11px;
  }
  .demo-user {
    padding: 9px 10px;
  }
  .demo-assistant {
    gap: 7px;
  }
  .demo-input {
    padding: 9px;
    margin: 6px 9px 12px;
  }
}
</style>
