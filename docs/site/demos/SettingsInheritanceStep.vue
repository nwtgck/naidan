<script setup lang="ts">
import { ChevronDownIcon, FolderIcon, GlobeIcon, MousePointer2Icon, SaveIcon, Settings2Icon } from 'lucide-vue-next';
import type { InheritanceGuideMessages } from '../messages';

defineProps<{
  stage: 'global' | 'group' | 'inheritedChat' | 'chatModel' | 'reset';
  copy: InheritanceGuideMessages['demo'];
}>();

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <div class="camera-viewport" :class="`stage-${stage}`" :data-docs-animation="`inheritance-${stage}`" :data-testid="`inheritance-step-${stage}`" aria-hidden="true">
    <div class="scene-canvas" data-testid="inheritance-camera-canvas">
      <aside class="app-sidebar">
        <strong class="app-brand">{{ copy.app }}</strong>
        <div class="sidebar-tree">
          <div class="group-item"><FolderIcon :size="17" /><span>{{ copy.groupName }}</span><MousePointer2Icon v-if="stage === 'group'" class="pointer sidebar-group-pointer" :size="23" /></div>
          <div class="chat-item">{{ copy.chatTitle }}</div>
        </div>
        <div class="sidebar-settings"><Settings2Icon :size="17" /><span>{{ copy.settings }}</span><MousePointer2Icon v-if="stage === 'global'" class="pointer sidebar-settings-pointer" :size="23" /></div>
      </aside>

      <main class="app-workspace">
        <template v-if="stage === 'group'">
          <div class="group-page">
            <div class="group-heading"><span class="heading-icon"><Settings2Icon :size="21" /></span><div><h3>{{ copy.groupSettings }}</h3><small>{{ copy.groupOverrides }}</small></div><span class="override-badge">{{ copy.localOverrides }}</span></div>
            <div class="page-content">
              <div class="presets"><span class="field-label">{{ copy.quickPresets }}</span><span class="preset-pill">Ollama</span></div>
              <div class="field"><span class="field-label">{{ copy.endpointType }}</span><div class="field-value endpoint-control"><span class="value-stack"><span class="phase-start">{{ copy.globalOllama }}</span><span class="phase-end">{{ copy.ollama }}</span></span><ChevronDownIcon :size="18" /><MousePointer2Icon class="pointer endpoint-pointer" :size="23" /></div></div>
              <div class="field group-url"><span class="field-label">{{ copy.endpointUrl }}</span><div class="field-value mono"><span>http://localhost:11435</span></div></div>
              <div class="field"><span class="field-label">{{ copy.groupModel }}</span><div class="field-value model-control"><span class="value-stack"><span class="phase-start muted">{{ copy.globalModel }}</span><span class="phase-end">{{ copy.groupValue }}</span></span><ChevronDownIcon :size="18" /><MousePointer2Icon class="pointer group-model-pointer" :size="23" /></div></div>
            </div>
          </div>
        </template>

        <template v-else>
          <div class="chat-page-header"><h3>{{ copy.chatTitle }}</h3><span class="model-trigger" data-testid="inheritance-header-model"><span v-if="stage === 'chatModel'" class="value-stack"><span class="phase-start">{{ copy.groupValue }}</span><span class="phase-end">{{ copy.chatValue }}</span></span><span v-else-if="stage === 'reset'" class="value-stack reset-stack"><span class="reset-initial">{{ copy.chatValue }}</span><span class="reset-cleared">{{ copy.groupValue }}</span><span class="reset-local-model">{{ copy.otherValue }}</span><span class="reset-final">{{ copy.groupValue }}</span></span><span v-else>{{ stage === 'global' ? copy.globalValue : copy.groupValue }}</span><Settings2Icon :size="16" /><MousePointer2Icon v-if="stage === 'inheritedChat'" class="pointer header-pointer" :size="23" /></span></div>
          <div class="chat-transcript"><div class="message-label">{{ copy.groupName }}</div><p>{{ copy.conversationPrompt }}</p><div class="message-label assistant-label">{{ copy.app }}</div><p>{{ copy.conversationReply }}</p></div>
        </template>
      </main>

      <template v-if="stage === 'global'">
        <div class="modal-veil" />
        <div class="settings-modal global-modal" data-testid="inheritance-global-modal">
          <div class="modal-heading"><span class="heading-icon"><Settings2Icon :size="20" /></span><strong>{{ copy.settings }}</strong></div>
          <div class="global-modal-body"><div class="modal-navigation"><GlobeIcon :size="17" />{{ copy.connection }}</div><div class="modal-fields">
            <h3 class="section-heading">{{ copy.globalHeading }}</h3>
            <div class="field"><span class="field-label">{{ copy.apiProvider }}</span><div class="field-value provider-control"><span class="value-stack"><span class="phase-start">{{ copy.openai }}</span><span class="phase-end">{{ copy.ollama }}</span></span><ChevronDownIcon :size="18" /><MousePointer2Icon class="pointer provider-pointer" :size="23" /></div></div>
            <div class="field"><span class="field-label">{{ copy.endpointUrl }}</span><div class="field-value mono url-control"><span class="value-stack"><span class="phase-start muted">http://localhost:1234/v1</span><span class="phase-end">http://localhost:11434</span></span><MousePointer2Icon class="pointer url-pointer" :size="23" /></div></div>
            <h3 class="section-heading model-heading">{{ copy.modelSelection }}</h3>
            <div class="field"><span class="field-label">{{ copy.defaultModel }}</span><div class="field-value model-control"><span class="value-stack"><span class="phase-start muted">{{ copy.none }}</span><span class="phase-end">{{ copy.globalValue }}</span></span><ChevronDownIcon :size="18" /><MousePointer2Icon class="pointer global-model-pointer" :size="23" /></div></div>
          </div></div>
          <div class="modal-footer"><div class="save-control"><SaveIcon :size="16" /><span class="value-stack"><span class="phase-start">{{ copy.save }}</span><span class="phase-end">{{ copy.saved }}</span></span><MousePointer2Icon class="pointer save-pointer" :size="23" /></div></div>
        </div>
      </template>

      <template v-else-if="stage !== 'group'">
        <div class="modal-veil chat-veil" />
        <div class="settings-modal chat-modal" data-testid="inheritance-chat-modal">
          <div class="modal-heading"><span class="heading-icon"><Settings2Icon :size="20" /></span><strong>{{ copy.chatSettings }}</strong><span v-if="stage !== 'inheritedChat'" class="override-badge">{{ copy.localOverrides }}</span></div>
          <div class="chat-modal-body">
            <div class="presets"><span class="field-label">{{ copy.quickPresets }}</span><span class="preset-pill">Ollama</span></div>
            <div class="field"><span class="field-label">{{ copy.endpointType }}</span><div class="field-value endpoint-control"><span v-if="stage === 'reset'" class="value-stack reset-stack"><span class="reset-initial muted">{{ copy.groupOllama }}</span><span class="reset-local-endpoint">{{ copy.openai }}</span><span class="reset-final muted">{{ copy.groupOllama }}</span></span><span v-else class="muted">{{ copy.groupOllama }}</span><ChevronDownIcon :size="18" /><MousePointer2Icon v-if="stage === 'reset'" class="pointer reset-pointer" :size="23" /></div></div>
            <div class="field"><span class="field-label">{{ copy.endpointUrl }}</span><div class="field-value mono"><span v-if="stage === 'reset'" class="value-stack reset-stack"><span class="reset-initial muted">{{ copy.groupUrl }}</span><span class="reset-local-endpoint">http://localhost:1234/v1</span><span class="reset-final muted">{{ copy.groupUrl }}</span></span><span v-else class="muted">{{ copy.groupUrl }}</span></div></div>
            <div class="field"><span class="field-label">{{ copy.chatModel }}</span><div class="field-value model-control"><span v-if="stage === 'chatModel'" class="value-stack"><span class="phase-start muted">{{ copy.groupModelValue }}</span><span class="phase-end">{{ copy.chatValue }}</span></span><span v-else-if="stage === 'reset'" class="value-stack reset-stack"><span class="reset-initial">{{ copy.chatValue }}</span><span class="reset-cleared muted">{{ copy.groupModelValue }}</span><span class="reset-local-model">{{ copy.otherValue }}</span><span class="reset-final muted">{{ copy.groupModelValue }}</span></span><span v-else class="muted">{{ copy.groupModelValue }}</span><ChevronDownIcon :size="18" /><MousePointer2Icon v-if="stage === 'chatModel'" class="pointer chat-model-pointer" :size="23" /><MousePointer2Icon v-if="stage === 'reset'" class="pointer reset-model-pointer" :size="23" /></div></div>
          </div>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.camera-viewport { --scene-surface:var(--surface);--scene-field:var(--surface-2);--scene-line:var(--line-strong);--scene-text:var(--text);--scene-muted:var(--muted);--scene-blue:var(--blue);position:relative;width:100%;max-width:680px;height:390px;margin-inline:auto;overflow:hidden;border:1px solid var(--scene-line);border-radius:16px;background:var(--bg);box-shadow:var(--panel-shadow);color:var(--scene-text); }
.scene-canvas { position:absolute;inset:0 auto auto 0;width:980px;height:680px;transform-origin:0 0;font:15px/1.45 ui-sans-serif,system-ui,sans-serif;animation-duration:12s;animation-timing-function:ease-in-out;animation-iteration-count:infinite; }
.stage-global .scene-canvas { animation-name:global-camera; }
.stage-group .scene-canvas { animation-name:group-camera; }
.stage-inheritedChat .scene-canvas { animation-name:inherited-camera;animation-duration:10s; }
.stage-chatModel .scene-canvas { animation-name:chat-model-camera; }
.stage-reset .scene-canvas { animation-name:reset-camera;animation-duration:16s; }
.app-sidebar { position:absolute;inset:0 auto 0 0;width:170px;display:flex;flex-direction:column;padding:20px 12px;border-right:1px solid var(--scene-line);background:var(--scene-surface); }
.app-brand { font-size:22px;letter-spacing:-.05em; }
.sidebar-tree { flex:1;padding-top:42px; }
.group-item,.chat-item,.sidebar-settings { position:relative;display:flex;align-items:center;gap:8px;min-height:41px;padding:8px 10px;border-radius:10px;font-weight:700; }
.group-item { color:var(--scene-blue);background:color-mix(in srgb,var(--scene-blue) 10%,var(--scene-surface)); }
.group-item svg,.sidebar-settings svg { flex:none; }
.chat-item { margin-left:25px;padding-left:12px;border-left:1px solid var(--scene-line);font-size:13px;color:var(--scene-muted); }
.sidebar-settings { border:1px solid var(--scene-line);color:var(--scene-muted); }
.app-workspace { position:absolute;inset:0 0 0 170px;background:var(--bg); }
.chat-page-header { display:flex;align-items:center;justify-content:flex-start;gap:22px;height:86px;padding:0 35px;border-bottom:1px solid var(--scene-line);background:var(--scene-surface); }
.chat-page-header h3 { margin:0;font-size:20px; }
.model-trigger { position:relative;display:flex;align-items:center;gap:8px;min-width:145px;padding:7px 12px;border-radius:20px;background:var(--scene-field);color:var(--scene-muted);font-size:13px;font-weight:750; }
.model-trigger > svg:not(.pointer) { flex:none;margin-left:auto; }
.chat-transcript { max-width:490px;margin:70px auto 0;padding:28px;border:1px solid var(--scene-line);border-radius:20px;background:var(--scene-surface);color:var(--scene-muted); }
.chat-transcript p { margin:5px 0 24px; }
.chat-transcript p:last-child { margin-bottom:0; }
.message-label { font-size:12px;font-weight:800;color:var(--scene-text); }
.assistant-label { color:var(--scene-blue); }
.group-page { width:445px;margin:70px 0 0 25px;border:1px solid var(--scene-line);border-radius:20px;background:var(--scene-surface);box-shadow:0 10px 30px #0002; }
.group-heading { display:flex;align-items:center;gap:14px;min-height:84px;padding:17px 24px;border-bottom:1px solid var(--scene-line); }
.group-heading h3 { margin:0;font-size:21px; }
.group-heading small { font-size:11px;font-weight:750;color:var(--scene-blue);text-transform:uppercase;letter-spacing:.08em; }
.heading-icon { display:inline-flex;align-items:center;justify-content:center;flex:none;width:36px;height:36px;border-radius:10px;background:color-mix(in srgb,var(--scene-blue) 11%,var(--scene-surface));color:var(--scene-blue); }
.override-badge { margin-left:auto;padding:5px 8px;border:1px solid color-mix(in srgb,var(--scene-blue) 38%,transparent);border-radius:16px;background:color-mix(in srgb,var(--scene-blue) 10%,var(--scene-surface));color:var(--scene-blue);font-size:10px;font-weight:800;text-align:center; }
.page-content { display:grid;gap:22px;padding:27px 38px 42px; }
.presets { display:flex;align-items:center;gap:15px;min-height:38px;padding-bottom:15px;border-bottom:1px solid var(--scene-line); }
.preset-pill { padding:7px 12px;border:1px solid var(--scene-line);border-radius:10px;background:var(--scene-field);color:var(--scene-muted);font-size:12px;font-weight:800; }
.field { display:grid;gap:8px;min-width:0; }
.field-label { color:var(--scene-muted);font-size:14px;font-weight:800;letter-spacing:.04em;text-transform:uppercase; }
.field-value { position:relative;display:flex;align-items:center;justify-content:space-between;gap:12px;min-width:0;min-height:49px;padding:12px 15px;border:1px solid var(--scene-line);border-radius:11px;background:var(--scene-field);font-size:17px;font-weight:750;overflow-wrap:anywhere; }
.field-value > svg:not(.pointer) { flex:none;color:var(--scene-muted); }
.field-value > span { min-width:0; }
.mono { font:16px/1.5 ui-monospace,SFMono-Regular,monospace;overflow-wrap:anywhere; }
.muted { color:var(--scene-muted);font-weight:650; }
.value-stack { display:grid;min-width:0; }
.value-stack > span { grid-area:1/1;min-width:0;overflow-wrap:anywhere; }
.phase-start { opacity:0; }
.phase-end { opacity:1; }
.reset-initial,.reset-cleared,.reset-local-endpoint,.reset-local-model { opacity:0; }
.reset-final { opacity:1; }
.modal-veil { position:absolute;inset:0;background:#070c17a8; }
.settings-modal { position:absolute;border:1px solid var(--scene-line);border-radius:19px;background:var(--scene-surface);box-shadow:0 25px 70px #0008; }
.modal-heading { display:flex;align-items:center;gap:12px;min-height:64px;padding:14px 22px;border-bottom:1px solid var(--scene-line);font-size:17px; }
.global-modal { left:245px;top:53px;width:540px; }
.global-modal-body { display:grid;grid-template-columns:137px minmax(0,1fr); }
.modal-navigation { display:flex;align-items:center;align-self:start;gap:8px;margin:18px 12px;padding:11px;border:1px solid var(--scene-line);border-radius:10px;background:var(--scene-field);color:var(--scene-blue);font-size:13px;font-weight:750; }
.modal-fields { display:grid;gap:16px;padding:20px 25px 24px;border-left:1px solid var(--scene-line); }
.section-heading { margin:0 0 2px;padding-bottom:9px;border-bottom:1px solid var(--scene-line);font-size:17px; }
.model-heading { margin-top:5px; }
.modal-footer { display:flex;justify-content:flex-end;padding:15px 20px;border-top:1px solid var(--scene-line); }
.save-control { position:relative;display:flex;align-items:center;gap:8px;min-width:150px;padding:10px 14px;border-radius:10px;background:#2563eb;color:white;font-size:13px;font-weight:800; }
.chat-modal { left:273px;top:135px;width:420px; }
.chat-modal-body { display:grid;gap:18px;padding:23px 31px 30px; }
.chat-modal-body .presets { min-height:34px; }
.pointer { position:absolute;z-index:5;right:1px;bottom:-7px;color:var(--scene-text);fill:var(--scene-surface);filter:drop-shadow(0 1px 2px #0009);pointer-events:none;animation:tap-middle 12s linear infinite; }
.sidebar-settings-pointer { animation-name:tap-early; }
.sidebar-group-pointer { animation-name:tap-early; }
.header-pointer { animation:tap-early 10s linear infinite; }
.provider-pointer { animation-name:tap-provider; }
.endpoint-pointer,.chat-model-pointer,.url-pointer { animation-name:tap-middle; }
.reset-pointer { animation:tap-reset-endpoint 16s linear infinite; }
.reset-model-pointer { animation:tap-reset-model 16s linear infinite; }
.url-pointer { right:35px; }
.global-model-pointer,.group-model-pointer { animation-name:tap-late; }
.save-pointer { animation-name:tap-end; }
.stage-global .global-modal,.stage-global .modal-veil { animation:modal-open 12s linear infinite; }
.stage-inheritedChat .chat-modal,.stage-inheritedChat .chat-veil { animation:chat-modal-open 10s linear infinite; }
.stage-global .provider-control .phase-start { animation:early-start 12s linear infinite; }
.stage-global .provider-control .phase-end { animation:early-end 12s linear infinite; }
.stage-global .url-control .phase-start { animation:middle-start 12s linear infinite; }
.stage-global .url-control .phase-end { animation:middle-end 12s linear infinite; }
.stage-global .model-control .phase-start { animation:late-start 12s linear infinite; }
.stage-global .model-control .phase-end { animation:late-end 12s linear infinite; }
.stage-global .save-control .phase-start { animation:end-start 12s linear infinite; }
.stage-global .save-control .phase-end { animation:end-end 12s linear infinite; }
.stage-group .endpoint-control .phase-start { animation:middle-start 12s linear infinite; }
.stage-group .endpoint-control .phase-end { animation:middle-end 12s linear infinite; }
.stage-group .group-url { animation:group-url-show 12s linear infinite; }
.stage-group .model-control .phase-start { animation:late-start 12s linear infinite; }
.stage-group .model-control .phase-end { animation:late-end 12s linear infinite; }
.stage-chatModel .model-control .phase-start,.stage-chatModel .model-trigger .phase-start { animation:middle-start 12s linear infinite; }
.stage-chatModel .model-control .phase-end,.stage-chatModel .model-trigger .phase-end { animation:middle-end 12s linear infinite; }
.stage-reset .reset-initial { animation:reset-initial-value 16s linear infinite; }
.stage-reset .reset-cleared { animation:reset-cleared-value 16s linear infinite; }
.stage-reset .reset-local-endpoint { animation:reset-local-endpoint-value 16s linear infinite; }
.stage-reset .reset-local-model { animation:reset-local-model-value 16s linear infinite; }
.stage-reset .reset-final { animation:reset-final-value 16s linear infinite; }
.stage-reset .override-badge { opacity:0;animation:reset-override-badge 16s linear infinite; }
@keyframes global-camera { 0%,12% { transform:translate(0,-195px) scale(.85); } 27%,55% { transform:translate(-120px,-80px) scale(.98); } 68%,94% { transform:translate(-120px,-210px) scale(.98); } 100% { transform:translate(0,-195px) scale(.85); } }
@keyframes group-camera { 0%,15% { transform:translate(0,-20px) scale(.85); } 33%,94% { transform:translate(-85px,-165px) scale(1.05); } 100% { transform:translate(0,-20px) scale(.85); } }
@keyframes inherited-camera { 0%,25% { transform:translate(-120px,-15px) scale(.85); } 65%,94% { transform:translate(-105px,-215px) scale(1.05); } 100% { transform:translate(-120px,-15px) scale(.85); } }
@keyframes chat-model-camera { 0%,15% { transform:translate(-105px,-215px) scale(1.05); } 30%,62% { transform:translate(-105px,-215px) scale(1.05); } 82%,94% { transform:translate(-120px,-15px) scale(.85); } 100% { transform:translate(-105px,-215px) scale(1.05); } }
@keyframes reset-camera { 0%,14%,100% { transform:translate(-120px,-15px) scale(.85); } 24%,94% { transform:translate(-105px,-215px) scale(1.05); } }
@keyframes modal-open { 0%,14%,100% { opacity:0; } 25%,94% { opacity:1; } }
@keyframes chat-modal-open { 0%,25%,100% { opacity:0; } 37%,94% { opacity:1; } }
@keyframes early-start { 0%,27%,100% { opacity:1; } 37%,94% { opacity:0; } }
@keyframes early-end { 0%,27%,100% { opacity:0; } 37%,94% { opacity:1; } }
@keyframes middle-start { 0%,46%,100% { opacity:1; } 56%,94% { opacity:0; } }
@keyframes middle-end { 0%,46%,100% { opacity:0; } 56%,94% { opacity:1; } }
@keyframes late-start { 0%,67%,100% { opacity:1; } 77%,94% { opacity:0; } }
@keyframes late-end { 0%,67%,100% { opacity:0; } 77%,94% { opacity:1; } }
@keyframes end-start { 0%,79%,100% { opacity:1; } 88%,94% { opacity:0; } }
@keyframes end-end { 0%,79%,100% { opacity:0; } 88%,94% { opacity:1; } }
@keyframes group-url-show { 0%,46%,100% { opacity:0; } 56%,94% { opacity:1; } }
@keyframes reset-initial-value { 0%,27%,100% { opacity:1; } 36%,94% { opacity:0; } }
@keyframes reset-cleared-value { 0%,27%,58%,100% { opacity:0; } 36%,50% { opacity:1; } }
@keyframes reset-local-endpoint-value { 0%,27%,84%,100% { opacity:0; } 36%,75% { opacity:1; } }
@keyframes reset-local-model-value { 0%,50%,84%,100% { opacity:0; } 58%,75% { opacity:1; } }
@keyframes reset-final-value { 0%,75%,100% { opacity:0; } 84%,94% { opacity:1; } }
@keyframes reset-override-badge { 0%,75%,100% { opacity:1; } 84%,94% { opacity:0; } }
@keyframes tap-early { 0%,5%,20%,100% { opacity:0;transform:translate(9px,9px); } 10%,15% { opacity:1;transform:none; } }
@keyframes tap-provider { 0%,25%,40%,100% { opacity:0;transform:translate(9px,9px); } 30%,35% { opacity:1;transform:none; } }
@keyframes tap-middle { 0%,42%,60%,100% { opacity:0;transform:translate(9px,9px); } 48%,53% { opacity:1;transform:none; } }
@keyframes tap-late { 0%,63%,81%,100% { opacity:0;transform:translate(9px,9px); } 69%,74% { opacity:1;transform:none; } }
@keyframes tap-end { 0%,77%,91%,100% { opacity:0;transform:translate(9px,9px); } 82%,86% { opacity:1;transform:none; } }
@keyframes tap-reset-endpoint { 0%,24%,34%,75%,85%,100% { opacity:0;transform:translate(9px,9px); } 28%,31%,78%,81% { opacity:1;transform:none; } }
@keyframes tap-reset-model { 0%,47%,59%,100% { opacity:0;transform:translate(9px,9px); } 51%,55% { opacity:1;transform:none; } }
@media(max-width:560px) {
  .camera-viewport { height:345px; }
  .stage-global .field-label { transform:translateX(24px);animation:global-label-shift 12s linear infinite; }
  .stage-group .field-label { transform:translateX(35px);animation:group-label-shift 12s linear infinite; }
  .stage-inheritedChat .field-label { transform:translateX(24px);animation:inherited-label-shift 10s linear infinite; }
  .stage-chatModel .field-label { transform:translateX(24px);animation:chat-model-label-shift 12s linear infinite; }
  .stage-reset .field-label { transform:translateX(24px);animation:reset-label-shift 16s linear infinite; }
  .stage-global .field-value > span { margin-left:12px; }
  .stage-group .field-value > span { margin-left:20px; }
  .stage-inheritedChat .field-value > span,.stage-chatModel .field-value > span,.stage-reset .field-value > span { margin-left:8px; }
  .field-value .pointer { right:16px; }
  .stage-global .save-control { margin-right:20px; }
  .stage-global .scene-canvas { animation-name:global-camera-mobile; }
  .stage-group .scene-canvas { animation-name:group-camera-mobile; }
  .stage-inheritedChat .scene-canvas { animation-name:inherited-camera-mobile; }
  .stage-chatModel .scene-canvas { animation-name:chat-model-camera-mobile; }
  .stage-reset .scene-canvas { animation-name:reset-camera-mobile; }
}
@keyframes global-camera-mobile { 0%,12% { transform:translate(0,-207px) scale(.82); } 25% { transform:translate(-320px,-70px) scale(.82); } 32%,55% { transform:translate(-342px,-70px) scale(.82); } 68%,94% { transform:translate(-342px,-190px) scale(.82); } 100% { transform:translate(0,-207px) scale(.82); } }
@keyframes group-camera-mobile { 0%,15% { transform:translate(0,-10px) scale(.82); } 33% { transform:translate(-177px,-130px) scale(.82); } 43%,94% { transform:translate(-212px,-130px) scale(.82); } 100% { transform:translate(0,-10px) scale(.82); } }
@keyframes inherited-camera-mobile { 0%,25% { transform:translate(-150px,-10px) scale(.82); } 45% { transform:translate(-235px,-145px) scale(.82); } 65%,94% { transform:translate(-260px,-145px) scale(.82); } 100% { transform:translate(-150px,-10px) scale(.82); } }
@keyframes chat-model-camera-mobile { 0%,15% { transform:translate(-260px,-145px) scale(.82); } 30% { transform:translate(-235px,-145px) scale(.82); } 42%,62% { transform:translate(-260px,-145px) scale(.82); } 82%,94% { transform:translate(-150px,-10px) scale(.82); } 100% { transform:translate(-260px,-145px) scale(.82); } }
@keyframes reset-camera-mobile { 0%,14%,100% { transform:translate(-150px,-10px) scale(.82); } 22% { transform:translate(-235px,-145px) scale(.82); } 27%,94% { transform:translate(-260px,-145px) scale(.82); } }
@keyframes global-label-shift { 0%,25%,100% { transform:none; } 32%,94% { transform:translateX(24px); } }
@keyframes group-label-shift { 0%,33%,100% { transform:none; } 43%,94% { transform:translateX(35px); } }
@keyframes inherited-label-shift { 0%,45%,100% { transform:none; } 65%,94% { transform:translateX(24px); } }
@keyframes chat-model-label-shift { 0%,15%,42%,94%,100% { transform:translateX(24px); } 30% { transform:none; } }
@keyframes reset-label-shift { 0%,22%,100% { transform:none; } 27%,94% { transform:translateX(24px); } }
:global(html:has(#docs-pause-motion:checked)) .camera-viewport *,
:global(html:has(#docs-pause-motion:checked)) .camera-viewport *::before,
:global(html:has(#docs-pause-motion:checked)) .camera-viewport *::after { animation:none!important; }
:global(html:has(#docs-pause-motion:checked)) .stage-global .scene-canvas { transform:translate(-120px,-210px) scale(.98); }
:global(html:has(#docs-pause-motion:checked)) .stage-group .scene-canvas { transform:translate(-85px,-165px) scale(1.05); }
:global(html:has(#docs-pause-motion:checked)) .stage-inheritedChat .scene-canvas { transform:translate(-105px,-215px) scale(1.05); }
:global(html:has(#docs-pause-motion:checked)) .stage-chatModel .scene-canvas { transform:translate(-120px,-15px) scale(.85); }
:global(html:has(#docs-pause-motion:checked)) .stage-reset .scene-canvas { transform:translate(-105px,-215px) scale(1.05); }
:global(html:has(#docs-pause-motion:checked)) .camera-viewport .pointer { display:none; }
@media(max-width:560px) {
  :global(html:has(#docs-pause-motion:checked)) .stage-global .scene-canvas { transform:translate(-342px,-190px) scale(.82); }
  :global(html:has(#docs-pause-motion:checked)) .stage-group .scene-canvas { transform:translate(-212px,-130px) scale(.82); }
  :global(html:has(#docs-pause-motion:checked)) .stage-inheritedChat .scene-canvas { transform:translate(-260px,-145px) scale(.82); }
  :global(html:has(#docs-pause-motion:checked)) .stage-chatModel .scene-canvas { transform:translate(-150px,-10px) scale(.82); }
  :global(html:has(#docs-pause-motion:checked)) .stage-reset .scene-canvas { transform:translate(-260px,-145px) scale(.82); }
}
@media(prefers-reduced-motion:reduce) {
  .camera-viewport *, .camera-viewport *::before, .camera-viewport *::after { animation:none!important; }
  .stage-global .scene-canvas { transform:translate(-120px,-210px) scale(.98); }
  .stage-group .scene-canvas { transform:translate(-85px,-165px) scale(1.05); }
  .stage-inheritedChat .scene-canvas { transform:translate(-105px,-215px) scale(1.05); }
  .stage-chatModel .scene-canvas { transform:translate(-120px,-15px) scale(.85); }
  .stage-reset .scene-canvas { transform:translate(-105px,-215px) scale(1.05); }
  .pointer { display:none; }
}
@media(max-width:560px) and (prefers-reduced-motion:reduce) {
  .stage-global .scene-canvas { transform:translate(-342px,-190px) scale(.82); }
  .stage-group .scene-canvas { transform:translate(-212px,-130px) scale(.82); }
  .stage-inheritedChat .scene-canvas { transform:translate(-260px,-145px) scale(.82); }
  .stage-chatModel .scene-canvas { transform:translate(-150px,-10px) scale(.82); }
  .stage-reset .scene-canvas { transform:translate(-260px,-145px) scale(.82); }
}
</style>
