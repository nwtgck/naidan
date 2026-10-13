<script setup lang="ts">
import { FileCodeIcon, FolderOpenIcon, MousePointer2Icon, ArchiveIcon } from 'lucide-vue-next';
import logo from '../../assets/naidan.svg';


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
  <div class="standalone-demo" data-docs-animation="open-local-html" lang="en" aria-hidden="true">
    <div class="standalone-files"><div class="file-window-title"><FolderOpenIcon :size="15" /><b>naidan-standalone</b></div><div class="standalone-file-row open-file"><FileCodeIcon :size="21" /><span>index.html<small>Open in your browser</small></span><MousePointer2Icon :size="18" class="open-pointer" /></div><div class="standalone-file-row"><FolderOpenIcon :size="21" /><span>assets/<small>Keep the extracted files together</small></span></div><div class="standalone-archive"><ArchiveIcon :size="12" />Extract the ZIP first</div></div>
    <div class="open-path"><span>Open</span><i /></div>
    <div class="standalone-window"><div class="file-address"><span>◇</span><code>file:///…/naidan/index.html</code></div><div class="standalone-app"><img :src="logo" width="39" height="39" alt=""><b>Naidan</b><p>New Chat</p><div class="standalone-composer">Type a message...<span>↑</span></div></div><div class="standalone-status"><i />Browser session <span>No app server</span></div></div>
  </div>
</template>

<style scoped>
.standalone-demo {
  display: grid;
  grid-template-columns: 1fr 48px 1.2fr;
  align-items: center;
  padding: 32px;
  background: linear-gradient(130deg,var(--surface),var(--bg));
  border: 1px solid var(--line-strong);
  border-radius: 20px;
  font: 12px/1.7 ui-sans-serif,system-ui,sans-serif;
}

.standalone-files {
  border: 1px solid var(--line-strong);
  background: var(--surface-2);
  border-radius: 11px;
  overflow: hidden;
}

.file-window-title {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 11px 14px;
  border-bottom: 1px solid var(--line);
  color: var(--muted);
}

.file-window-title b {
  font-size: 10px;
  font-weight: 500;
}

.standalone-file-row {
  position: relative;
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 12px 13px;
  color: var(--muted);
}

.standalone-file-row svg {
  color: var(--blue);
  flex-shrink: 0;
}

.standalone-file-row small {
  display: block;
  font-size: 8px;
  color: var(--subtle);
}

.open-file {
  background: #3b82f617;
  color: var(--text);
}

.open-pointer {
  position: absolute;
  right: 17px;
  bottom: 9px;
  filter: drop-shadow(0 2px 2px #0003);
  animation: docs-file-click 10s ease-in-out infinite;
}

.standalone-archive {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 9px 13px;
  border-top: 1px solid var(--line);
  color: var(--subtle);
  font-size: 9px;
}

.open-path {
  display: flex;
  flex-direction: column;
  align-items: center;
  color: var(--subtle);
  font-size: 9px;
  gap: 6px;
}

.open-path i {
  height: 1px;
  width: 26px;
  background: var(--blue);
  position: relative;
}

.open-path i::after {
  content: '';
  position: absolute;
  right: 0;
  top: -2px;
  width: 5px;
  height: 5px;
  border-top: 1px solid var(--blue);
  border-right: 1px solid var(--blue);
  transform: rotate(45deg);
}

.standalone-window {
  background: #111827;
  border: 1px solid #435370;
  border-radius: 13px;
  overflow: hidden;
  color: #e5e7eb;
  transform-origin: left center;
  animation: docs-local-open 10s ease-in-out infinite;
}

.file-address {
  padding: 11px;
  background: #1b2638;
  color: #8fb6f6;
  display: flex;
  gap: 8px;
}

.file-address code {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font: 9px/1.8 ui-monospace,monospace;
  color: #c2d0e3;
}

.standalone-app {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 32px 18px 20px;
}

.standalone-app b {
  font-size: 21px;
  letter-spacing: -.05em;
  margin-top: 8px;
}

.standalone-app p {
  font-size: 10px;
  color: #8093b0;
  margin: 2px 0 22px;
}

.standalone-composer {
  width: 100%;
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 10px 12px;
  border: 1px solid #374151;
  background: #1f2937;
  color: #8c9db7;
  border-radius: 11px;
  font-size: 9px;
}

.standalone-composer span {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 21px;
  height: 21px;
  border-radius: 6px;
  background: #2563eb;
  color: white;
  font-size: 13px;
}

.standalone-status {
  display: flex;
  align-items: center;
  gap: 6px;
  border-top: 1px solid #29364b;
  padding: 9px 12px;
  color: #91a4bf;
  font-size: 8px;
}

.standalone-status i {
  height: 4px;
  width: 4px;
  border-radius: 100%;
  background: #8addb8;
}

.standalone-status span {
  margin-left: auto;
}

@keyframes docs-file-click {
  0%,10% {
    transform: translate(8px,12px);
    opacity: .35;
  }
  22%,28% {
    transform: translate(0,0);
    opacity: 1;
  }
  25% {
    transform: translate(0,0) scale(.82);
  }
  45%,100% {
    transform: translate(0,0);
    opacity: .35;
  }
}

@keyframes docs-local-open {
  0%,20% {
    transform: translateX(7px) scale(.98);
    border-color: #435370;
  }
  34%,60% {
    transform: translateX(0) scale(1);
    border-color: #79b9ff;
  }
  75%,100% {
    transform: translateX(0) scale(1);
    border-color: #435370;
  }
}

@media(max-width:640px) {
  .standalone-demo {
    grid-template-columns: 1fr;
    padding: 20px;
    gap: 18px;
  }
  .open-path {
    display: none;
  }
  .standalone-file-row {
    padding: 9px 13px;
  }
  .standalone-app {
    padding-top: 24px;
  }
}
</style>
