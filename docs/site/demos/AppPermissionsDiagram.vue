<script setup lang="ts">
import { ActivityIcon, AppWindowIcon, ArrowRightIcon, FileTextIcon, FolderClosedIcon, GlobeIcon, MicIcon, MonitorIcon, ShieldIcon, SmartphoneIcon, UserRoundIcon, WaypointsIcon } from 'lucide-vue-next';
import type { AppPermissionsMessages } from '../messages';

defineProps<{ mode: 'desktop' | 'mobile' | 'web' | 'send' | 'noPrompt'; copy: AppPermissionsMessages['visual'] }>();
defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <div class="access-scene" :class="'scene-' + mode" :data-docs-animation="'app-permissions-' + mode" :data-testid="'app-permissions-' + mode + '-diagram'" role="img" :aria-label="copy[mode].caption">
    <template v-if="mode === 'desktop'">
      <div class="scene-eyebrow"><MonitorIcon :size="17" />{{ copy.desktop.eyebrow }}</div>
      <div class="authority"><UserRoundIcon :size="16" />{{ copy.desktop.account }}</div>
      <div class="scene-flow">
        <div class="node"><FileTextIcon :size="21" /><strong>{{ copy.desktop.file }}</strong><code>{{ copy.desktop.fileName }}</code><span class="sample">{{ copy.desktop.sample }}</span></div>
        <ArrowRightIcon class="flow-arrow" :size="20" />
        <div class="node node--destination"><AppWindowIcon :size="21" /><strong>{{ copy.desktop.program }}</strong><span class="received">{{ copy.desktop.sample }}</span></div>
      </div>
      <div class="path-track"><span class="moving-chip">{{ copy.desktop.sample }}</span><ArrowRightIcon class="track-end" :size="17" /></div>
      <p class="scene-result">{{ copy.desktop.outcome }} <span>{{ copy.desktop.limit }}</span></p>
    </template>

    <template v-else-if="mode === 'mobile'">
      <div class="scene-eyebrow"><SmartphoneIcon :size="17" />{{ copy.mobile.eyebrow }}</div>
      <div class="mobile-routes">
        <div class="mobile-route route-blocked">
          <div class="scene-flow">
            <div class="node"><FolderClosedIcon :size="20" /><strong>{{ copy.mobile.privateData }}</strong></div>
            <ShieldIcon class="flow-arrow" :size="20" />
            <div class="node node--protected"><SmartphoneIcon :size="20" /><strong>{{ copy.mobile.app }}</strong><span class="received">{{ copy.mobile.blocked }}</span></div>
          </div>
          <div class="path-track path-track--blocked"><span class="moving-chip">{{ copy.mobile.blockedToken }}</span><ShieldIcon class="track-stop" :size="21" /></div>
        </div>
        <div class="mobile-route route-sensor">
          <div class="scene-flow">
            <div class="node"><ActivityIcon :size="20" /><strong>{{ copy.mobile.sensor }}</strong><span class="sample">{{ copy.mobile.sensorValue }}</span></div>
            <ArrowRightIcon class="flow-arrow" :size="20" />
            <div class="node node--destination"><SmartphoneIcon :size="20" /><strong>{{ copy.mobile.app }}</strong><span class="received">{{ copy.mobile.sensorValue }}</span></div>
          </div>
          <div class="path-track"><span class="moving-chip">{{ copy.mobile.sensorValue }}</span><ArrowRightIcon class="track-end" :size="17" /></div>
        </div>
      </div>
      <p class="scene-result">{{ copy.mobile.available }}</p>
    </template>

    <template v-else-if="mode === 'web'">
      <div class="scene-eyebrow"><GlobeIcon :size="17" />{{ copy.web.eyebrow }}</div>
      <div class="scene-flow scene-flow--three">
        <div class="node"><FileTextIcon :size="20" /><strong>{{ copy.web.file }}</strong><code>{{ copy.web.fileName }}</code></div>
        <ArrowRightIcon class="flow-arrow" :size="18" />
        <div class="node node--browser"><FolderClosedIcon :size="20" /><strong>{{ copy.web.browser }}</strong><span class="sample">{{ copy.web.fileName }}</span></div>
        <ArrowRightIcon class="flow-arrow" :size="18" />
        <div class="node node--destination"><AppWindowIcon :size="20" /><strong>{{ copy.web.page }}</strong><span class="received">{{ copy.web.received }}</span></div>
      </div>
      <div class="path-track path-track--web"><span class="moving-chip">{{ copy.web.fileName }}</span><span class="browser-marker" /><ArrowRightIcon class="track-end" :size="17" /></div>
      <p class="scene-result"><ShieldIcon :size="16" />{{ copy.web.outside }}</p>
    </template>

    <template v-else-if="mode === 'send'">
      <div class="send-routes">
        <div class="send-route send-route--desktop">
          <div class="scene-flow scene-flow--three">
            <div class="node"><FileTextIcon :size="18" /><strong>{{ copy.send.desktop }}</strong><span class="sample">{{ copy.desktop.sample }}</span></div>
            <ArrowRightIcon class="flow-arrow" :size="17" />
            <div class="node"><MonitorIcon :size="18" /><strong>{{ copy.send.desktopApp }}</strong></div>
            <ArrowRightIcon class="flow-arrow" :size="17" />
            <div class="node node--destination"><GlobeIcon :size="18" /><strong>{{ copy.send.service }}</strong><span class="received">{{ copy.desktop.sample }}</span></div>
          </div>
          <div class="path-track"><span class="moving-chip">{{ copy.desktop.sample }}</span><ArrowRightIcon class="track-end" :size="17" /></div>
        </div>
        <div class="send-route send-route--mobile">
          <div class="scene-flow scene-flow--three">
            <div class="node"><ActivityIcon :size="18" /><strong>{{ copy.send.mobile }}</strong><span class="sample">{{ copy.mobile.sensorValue }}</span></div>
            <ArrowRightIcon class="flow-arrow" :size="17" />
            <div class="node"><SmartphoneIcon :size="18" /><strong>{{ copy.send.mobileApp }}</strong></div>
            <ArrowRightIcon class="flow-arrow" :size="17" />
            <div class="node node--destination"><GlobeIcon :size="18" /><strong>{{ copy.send.service }}</strong><span class="received">{{ copy.mobile.sensorValue }}</span></div>
          </div>
          <div class="path-track"><span class="moving-chip">{{ copy.mobile.sensorValue }}</span><ArrowRightIcon class="track-end" :size="17" /></div>
        </div>
        <div class="send-route send-route--web">
          <div class="scene-flow scene-flow--three">
            <div class="node"><FileTextIcon :size="18" /><strong>{{ copy.send.web }}</strong><span class="sample">{{ copy.web.fileName }}</span></div>
            <ArrowRightIcon class="flow-arrow" :size="17" />
            <div class="node"><AppWindowIcon :size="18" /><strong>{{ copy.send.webApp }}</strong></div>
            <ArrowRightIcon class="flow-arrow" :size="17" />
            <div class="node node--destination"><GlobeIcon :size="18" /><strong>{{ copy.send.service }}</strong><span class="received">{{ copy.web.fileName }}</span></div>
          </div>
          <div class="path-track"><span class="moving-chip">{{ copy.web.fileName }}</span><ArrowRightIcon class="track-end" :size="17" /></div>
        </div>
      </div>
    </template>

    <template v-else>
      <div class="scene-eyebrow"><WaypointsIcon :size="17" />{{ copy.noPrompt.eyebrow }}</div>
      <div class="permission-lanes">
        <div class="permission-lane">
          <div class="lane-head"><GlobeIcon :size="19" /><strong>{{ copy.noPrompt.internet }}</strong><small>{{ copy.noPrompt.noDialog }}</small></div>
          <div class="permission-flow"><span>{{ copy.noPrompt.declaration }}</span><ArrowRightIcon :size="17" /><span>{{ copy.noPrompt.automatic }}</span><ArrowRightIcon :size="17" /><b>{{ copy.noPrompt.connected }}</b></div>
        </div>
        <div class="permission-lane">
          <div class="lane-head"><MicIcon :size="19" /><strong>{{ copy.noPrompt.microphone }}</strong><small>{{ copy.noPrompt.dialog }}</small></div>
          <div class="permission-flow"><span>{{ copy.noPrompt.declaration }}</span><ArrowRightIcon :size="17" /><span>{{ copy.noPrompt.request }}</span><ArrowRightIcon :size="17" /><b>{{ copy.noPrompt.approved }}</b></div>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.access-scene { min-width:0; padding:18px; border:1px solid var(--line-strong); border-radius:16px; background:var(--surface-2); box-shadow:var(--panel-shadow); color:var(--text); font:12px/1.55 ui-sans-serif,system-ui,sans-serif; }
.scene-eyebrow { display:flex; align-items:center; gap:8px; margin-bottom:12px; color:var(--blue); font-size:12px; font-weight:800; }
.scene-eyebrow svg,.authority svg { flex:none; }
.authority { display:flex; align-items:center; gap:7px; width:fit-content; max-width:100%; margin-bottom:10px; padding:5px 9px; border:1px solid var(--line); border-radius:7px; background:var(--surface); color:var(--muted); font-size:12px; }
.scene-flow { display:grid; grid-template-columns:minmax(0,1fr) 22px minmax(0,1fr); align-items:stretch; gap:9px; min-width:0; }
.scene-flow--three { grid-template-columns:minmax(0,1fr) 18px minmax(0,1fr) 18px minmax(0,1fr); gap:6px; }
.node { display:flex; flex-direction:column; align-items:flex-start; justify-content:center; gap:4px; min-width:0; min-height:83px; padding:10px 12px; border:1px solid var(--line-strong); border-radius:11px; background:var(--surface); }
.node > svg { flex:none; color:var(--blue); }
.node strong { font-size:12px; font-weight:750; line-height:1.45; overflow-wrap:anywhere; }
.node code { color:var(--muted); font-size:12px; overflow-wrap:anywhere; }
.node--browser { border-color:color-mix(in srgb,var(--blue) 45%,var(--line-strong)); }
.node--destination { border-color:color-mix(in srgb,var(--green) 45%,var(--line-strong)); background:color-mix(in srgb,var(--green) 5%,var(--surface)); }
.node--destination > svg { color:var(--green); }
.node--protected { border-color:color-mix(in srgb,var(--blue) 45%,var(--line-strong)); background:color-mix(in srgb,var(--blue) 6%,var(--surface)); }
.sample,.received { display:block; min-width:0; padding:3px 6px; border-radius:5px; font-size:12px; line-height:1.4; overflow-wrap:anywhere; }
.sample { background:var(--surface-3); color:var(--text); }
.received { background:color-mix(in srgb,var(--green) 13%,var(--surface)); color:var(--text); }
.node--protected .received { background:color-mix(in srgb,var(--blue) 13%,var(--surface)); }
.flow-arrow { align-self:center; justify-self:center; color:var(--blue); }
.path-track { position:relative; height:32px; margin-top:7px; }
.path-track::before { position:absolute; top:15px; right:10px; left:0; height:2px; background:color-mix(in srgb,var(--blue) 55%,var(--line)); content:""; }
.moving-chip { position:absolute; z-index:1; top:2px; left:calc(100% - 83px); display:grid; place-items:center; width:78px; min-height:25px; padding:1px 3px; border:1px solid var(--blue); border-radius:7px; background:var(--surface); color:var(--text); font-size:11px; font-weight:750; text-align:center; white-space:nowrap; box-shadow:0 2px 6px #0002; }
.track-end { position:absolute; top:7px; right:-1px; color:var(--blue); }
.track-stop { position:absolute; z-index:2; top:5px; right:33%; padding:3px; box-sizing:content-box; border-radius:50%; background:var(--surface-2); color:var(--blue); }
.path-track--blocked::before { background:linear-gradient(90deg,color-mix(in srgb,var(--blue) 60%,var(--line)) 65%,var(--line) 65%); }
.path-track--blocked .moving-chip { left:calc(67% - 105px); }
.browser-marker { position:absolute; top:9px; left:50%; width:1px; height:15px; background:var(--blue); opacity:.65; }
.scene-result { display:flex; align-items:center; flex-wrap:wrap; gap:6px; margin:8px 0 0; font-size:12px; font-weight:700; }
.scene-result svg { flex:none; color:var(--green); }
.scene-result span { color:var(--muted); font-weight:400; }
.mobile-routes,.send-routes { display:grid; gap:13px; }
.mobile-route,.send-route { min-width:0; padding:11px; border:1px solid var(--line); border-radius:12px; background:var(--surface); }
.mobile-route .node,.send-route .node { min-height:77px; }
.send-route .node { padding:8px; }
.send-route .path-track { margin-top:5px; }
.permission-lanes { display:grid; gap:11px; }
.permission-lane { min-width:0; padding:12px; border:1px solid var(--line-strong); border-radius:11px; background:var(--surface); }
.lane-head { display:flex; align-items:center; gap:8px; margin-bottom:10px; }
.lane-head svg { flex:none; color:var(--blue); }
.lane-head strong { font-size:13px; }
.lane-head small { margin-left:auto; color:var(--muted); font-size:12px; }
.permission-flow { display:grid; grid-template-columns:minmax(0,1fr) 18px minmax(0,1fr) 18px minmax(0,1fr); align-items:center; gap:7px; }
.permission-flow span,.permission-flow b { min-width:0; padding:9px; border-radius:7px; background:var(--surface-3); font-size:12px; line-height:1.5; text-align:center; overflow-wrap:anywhere; }
.permission-flow b { background:color-mix(in srgb,var(--green) 12%,var(--surface)); color:var(--text); }
.permission-flow svg { justify-self:center; color:var(--blue); }
.scene-desktop .moving-chip,.scene-web .moving-chip { animation:travel 8s ease-in-out infinite; }
.scene-mobile .route-blocked .moving-chip { animation:travel-blocked 10s ease-in-out infinite; }
.scene-mobile .route-sensor .moving-chip { animation:travel-sensor 10s ease-in-out infinite; }
.send-route--desktop .moving-chip { animation:travel 12s ease-in-out infinite; }
.send-route--mobile .moving-chip { animation:travel 12s ease-in-out -4s infinite; }
.send-route--web .moving-chip { animation:travel 12s ease-in-out -8s infinite; }
.scene-desktop .received,.scene-web .received { animation:result-arrive 8s ease-in-out infinite; }
.route-sensor .received { animation:result-arrive-sensor 10s ease-in-out infinite; }
.send-route--desktop .received { animation:result-arrive 12s ease-in-out infinite; }
.send-route--mobile .received { animation:result-arrive 12s ease-in-out -4s infinite; }
.send-route--web .received { animation:result-arrive 12s ease-in-out -8s infinite; }
.permission-flow span:first-child,.permission-flow span:nth-of-type(2),.permission-flow b { animation:permission-step 9s ease-in-out infinite; }
.permission-flow span:nth-of-type(2) { animation-delay:3s; }
.permission-flow b { animation-delay:6s; }
@keyframes travel { 0%,10% { left:0; opacity:0; } 20% { opacity:1; } 60%,88% { left:calc(100% - 83px); opacity:1; } 100% { opacity:0; } }
@keyframes travel-blocked { 0%,9% { left:0; opacity:0; } 17% { opacity:1; } 34%,56% { left:calc(67% - 105px); opacity:1; } 64%,100% { left:calc(67% - 105px); opacity:0; } }
@keyframes travel-sensor { 0%,45% { left:0; opacity:0; } 53% { opacity:1; } 76%,92% { left:calc(100% - 83px); opacity:1; } 100% { opacity:0; } }
@keyframes result-arrive { 0%,54% { box-shadow:none; } 65%,82% { box-shadow:0 0 0 3px color-mix(in srgb,var(--green) 25%,transparent); } 100% { box-shadow:none; } }
@keyframes result-arrive-sensor { 0%,72% { box-shadow:none; } 79%,93% { box-shadow:0 0 0 3px color-mix(in srgb,var(--green) 25%,transparent); } 100% { box-shadow:none; } }
@keyframes permission-step { 0%,30% { box-shadow:0 0 0 3px color-mix(in srgb,var(--blue) 23%,transparent); } 37%,100% { box-shadow:none; } }
:global(html:has(#docs-pause-motion:checked)) .access-scene *, :global(html:has(#docs-pause-motion:checked)) .access-scene *::before, :global(html:has(#docs-pause-motion:checked)) .access-scene *::after { animation:none!important; }
@media(prefers-reduced-motion:reduce) { .access-scene *, .access-scene *::before, .access-scene *::after { animation:none!important; } }
@media(max-width:620px) {
  .access-scene { padding:13px; }
  .scene-flow { gap:6px; }
  .scene-flow--three { grid-template-columns:minmax(0,1fr) 14px minmax(0,1fr) 14px minmax(0,1fr); gap:3px; }
  .scene-flow--three .node { padding:8px 6px; }
  .scene-flow--three .node strong,.scene-flow--three .sample,.scene-flow--three .received { font-size:12px; }
  .mobile-route,.send-route { padding:8px; }
  .lane-head { flex-wrap:wrap; }
  .lane-head small { margin-left:0; }
  .permission-flow { grid-template-columns:minmax(0,1fr); gap:5px; }
  .permission-flow svg { transform:rotate(90deg); }
  .permission-flow span,.permission-flow b { padding:8px; text-align:left; }
}
</style>
