<script setup lang="ts">
import { BookOpenIcon, CalculatorIcon, ListIcon, MousePointer2Icon, SendIcon, Settings2Icon, SquarePenIcon, TerminalIcon } from 'lucide-vue-next';
import type { strings } from '../../pages/tool-wikipedia/strings/en';

defineProps<{ stage: 'open' | 'enabled'; copy: typeof strings.demo }>();
defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <div class="wiki-settings-scene" :class="`stage-${stage}`" :data-docs-animation="`wikipedia-settings-${stage}`" :data-testid="`wikipedia-settings-${stage}`" aria-hidden="true">
    <div class="app-sidebar">
      <strong class="brand">Naidan</strong>
      <div class="new-chat"><SquarePenIcon :size="15" />{{ copy.newChat }}</div>
      <div class="chat-list-item">{{ copy.chatTitle }}</div>
    </div>
    <div class="app-main">
      <div class="chat-header">{{ copy.chatTitle }}</div>
      <div class="chat-space" />
      <div class="chat-composer">
        <div class="message-placeholder">{{ copy.messagePlaceholder }}</div>
        <div class="composer-footer">
          <span class="model-select">{{ copy.model }}</span>
          <span class="tools-button" :title="copy.tools"><Settings2Icon :size="18" /><MousePointer2Icon v-if="stage === 'open'" class="pointer" :size="21" /></span>
          <span class="send-button"><SendIcon :size="15" /></span>
        </div>
      </div>
    </div>

    <div class="tool-sheet">
      <div class="sheet-handle" />
      <div class="sheet-title">{{ copy.options }}</div>
      <div class="tool-card muted"><span class="tool-icon"><CalculatorIcon :size="15" /></span><span class="tool-name">{{ copy.calculator }}</span><span class="toggle"><i /></span></div>
      <div class="tool-card muted"><span class="tool-icon"><ListIcon :size="15" /></span><span class="tool-name">{{ copy.choices }}</span><span class="toggle"><i /></span></div>
      <div class="tool-card wikipedia"><span class="tool-icon"><BookOpenIcon :size="15" /></span><span class="tool-label"><strong>{{ copy.wikipedia }}</strong><small>{{ copy.wikipediaDescription }}</small></span><span class="toggle"><b class="off">{{ copy.off }}</b><b class="on">{{ copy.on }}</b><i /></span><MousePointer2Icon v-if="stage === 'enabled'" class="wiki-pointer" :size="21" /></div>
      <div class="tool-card shell"><span class="tool-icon"><TerminalIcon :size="15" /></span><span class="tool-label"><strong>{{ copy.shell }}</strong><small>{{ copy.shellDescription }}</small></span><span class="toggle"><b class="off">{{ copy.off }}</b><b class="on">{{ copy.on }}</b><i /></span></div>
      <div class="mount-detail"><strong>{{ copy.mount }} <code>/sys/fs/naidan</code></strong><span>{{ copy.currentChat }}</span></div>
      <div class="sheet-close">{{ copy.closeMenu }}</div>
    </div>
  </div>
</template>

<style scoped>
.wiki-settings-scene{height:340px;max-width:680px;margin-inline:auto;position:relative;display:flex;overflow:hidden;border:1px solid var(--line-strong);border-radius:14px;background:#111827;color:#e5e7eb;font:12px/1.45 ui-sans-serif,system-ui,sans-serif;box-shadow:var(--panel-shadow)}
.app-sidebar{display:flex;flex:none;flex-direction:column;gap:12px;width:145px;padding:17px 10px;background:#172030;border-right:1px solid #303d50}.brand{font-size:15px}.new-chat,.chat-list-item{display:flex;align-items:center;gap:8px;padding:8px;border:1px solid #39455a;border-radius:8px;color:#cbd5e1;font-size:11px}.chat-list-item{border:0;background:#253858;color:#93c5fd}
.app-main{display:flex;flex:1;min-width:0;flex-direction:column}.chat-header{padding:13px 16px;border-bottom:1px solid #303d50;font-weight:700}.chat-space{flex:1}.chat-composer{margin:12px 17px 16px;border:1px solid #39455a;border-radius:12px;background:#1f2937}.message-placeholder{min-height:43px;padding:12px;color:#8995aa}.composer-footer{display:flex;align-items:center;gap:8px;padding:0 9px 8px}.model-select{border:1px solid #475569;border-radius:7px;padding:5px 9px;color:#cbd5e1;font-size:10px}.tools-button{position:relative;padding:5px;border-radius:7px;background:#1e3a5f;color:#93c5fd}.pointer,.wiki-pointer{position:absolute;color:#f8fafc;fill:#111827;filter:drop-shadow(0 1px 2px #0009)}.pointer{right:-14px;bottom:-13px;animation:tool-pointer 7s linear infinite}.send-button{margin-left:auto;padding:6px 9px;border-radius:7px;background:#2563eb;color:#fff}
.tool-sheet{position:absolute;left:155px;right:10px;bottom:9px;min-height:269px;padding:6px 12px 0;border:1px solid #465164;border-radius:14px 14px 7px 7px;background:#1f2937;box-shadow:0 -12px 38px #0009;transform:translateY(calc(100% + 12px));animation:sheet-open 7s ease-in-out infinite}.sheet-handle{width:42px;height:4px;margin:0 auto 7px;border-radius:9px;background:#64748b}.sheet-title{margin:0 -12px 5px;padding:2px 12px 6px;border-bottom:1px solid #374151;color:#94a3b8;text-transform:uppercase;font-size:10px;font-weight:800;letter-spacing:.08em}.tool-card{position:relative;display:flex;align-items:center;gap:9px;min-height:39px;margin:3px 0;padding:5px 8px;border:1px solid #374151;border-radius:9px;background:#273244}.tool-card.muted{opacity:.68}.tool-icon{display:grid;flex:none;place-items:center;width:25px;height:25px;border-radius:6px;background:#374151;color:#94a3b8}.tool-name{flex:1;font-size:11px;font-weight:700}.tool-label{display:grid;min-width:0;flex:1}.tool-label strong{font-size:11px}.tool-label small{color:#94a3b8;font-size:9px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.toggle{position:relative;display:block;flex:none;width:42px;height:21px;border-radius:99px;background:#64748b;color:#fff;font-size:7px;font-weight:900}.toggle b{position:absolute;top:6px}.toggle .off{right:4px}.toggle .on{left:4px;display:none}.toggle i{position:absolute;top:2px;left:2px;width:17px;height:17px;border-radius:50%;background:#fff;box-shadow:0 1px 4px #0005}.wiki-pointer{right:0;bottom:-12px;animation:wiki-pointer 7s linear infinite}.mount-detail{display:flex;align-items:center;justify-content:space-between;gap:10px;min-height:27px;padding:3px 9px;border:1px solid #374151;border-radius:7px;color:#94a3b8;font-size:9px;opacity:0}.mount-detail strong{font:10px ui-monospace,monospace;color:#cbd5e1}.sheet-close{margin:6px -12px 0;padding:6px;text-align:center;border-top:1px solid #374151;color:#94a3b8;font-size:9px;font-weight:800;text-transform:uppercase}
.stage-enabled .tool-sheet{transform:none;animation:none}.stage-enabled .wikipedia,.stage-enabled .shell{border-color:#2e5a91;background:#243a57;animation:card-on 7s linear infinite}.stage-enabled .wikipedia .tool-icon,.stage-enabled .shell .tool-icon{background:#2563eb;color:#fff;animation:icon-on 7s linear infinite}.stage-enabled .wikipedia .toggle,.stage-enabled .shell .toggle{background:#2563eb;animation:switch-on 7s linear infinite}.stage-enabled .wikipedia .toggle i,.stage-enabled .shell .toggle i{left:23px;animation:thumb-on 7s linear infinite}.stage-enabled .wikipedia .toggle .off,.stage-enabled .shell .toggle .off{opacity:0;animation:off-label 7s linear infinite}.stage-enabled .wikipedia .toggle .on,.stage-enabled .shell .toggle .on{display:block;animation:on-label 7s linear infinite}.stage-enabled .mount-detail{opacity:1;animation:mount-arrive 7s linear infinite}
@keyframes sheet-open{0%,20%{transform:translateY(calc(100% + 12px))}38%,92%{transform:none}100%{transform:translateY(calc(100% + 12px))}}@keyframes tool-pointer{0%,12%,35%,100%{opacity:0;transform:translate(8px,8px)}18%,27%{opacity:1;transform:none}}@keyframes wiki-pointer{0%,13%,47%,100%{opacity:0;transform:translate(8px,8px)}22%,40%{opacity:1;transform:none}}@keyframes card-on{0%,39%{border-color:#374151;background:#273244}40%,100%{border-color:#2e5a91;background:#243a57}}@keyframes icon-on{0%,39%{background:#374151;color:#94a3b8}40%,100%{background:#2563eb;color:#fff}}@keyframes switch-on{0%,39%{background:#64748b}40%,100%{background:#2563eb}}@keyframes thumb-on{0%,39%{left:2px}40%,100%{left:23px}}@keyframes off-label{0%,39%{opacity:1}40%,100%{opacity:0}}@keyframes on-label{0%,39%{opacity:0}40%,100%{opacity:1}}@keyframes mount-arrive{0%,43%{opacity:0}62%,100%{opacity:1}}
html:has(#docs-pause-motion:checked) .wiki-settings-scene *{animation:none!important}html:has(#docs-pause-motion:checked) .stage-open .tool-sheet{transform:none}html:has(#docs-pause-motion:checked) .wiki-settings-scene .pointer,html:has(#docs-pause-motion:checked) .wiki-settings-scene .wiki-pointer{display:none}html:has(#docs-pause-motion:checked) .stage-enabled .mount-detail{opacity:1}
@media(prefers-reduced-motion:reduce){.wiki-settings-scene *{animation:none!important}.stage-open .tool-sheet{transform:none}.wiki-settings-scene .pointer,.wiki-settings-scene .wiki-pointer{display:none}.stage-enabled .mount-detail{opacity:1}}
@media(max-width:590px){.app-sidebar{display:none}.tool-sheet{left:9px;right:9px}.chat-header{font-size:11px}.tool-card{min-height:40px}.wiki-settings-scene{height:340px}}
</style>
