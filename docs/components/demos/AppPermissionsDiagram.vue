<script setup lang="ts">
import { ActivityIcon, AppWindowIcon, ArrowRightIcon, FileTextIcon, FolderClosedIcon, GlobeIcon, MicIcon, MonitorIcon, ShieldIcon, SmartphoneIcon, UserRoundIcon, WaypointsIcon } from 'lucide-vue-next';
import { computed } from 'vue';
import type { messages as englishMessages } from '../../pages/web-and-native-app-permissions/messages/en';

const props = defineProps<{ mode: 'desktop' | 'mobile' | 'web' | 'send' | 'noPrompt'; messages: typeof englishMessages }>();
const caption = computed(() => {
  switch (props.mode) {
  case 'desktop': return props.messages.desktop_access_caption;
  case 'mobile': return props.messages.mobile_access_caption;
  case 'web': return props.messages.web_access_caption;
  case 'send': return props.messages.sending_paths_caption;
  case 'noPrompt': return props.messages.permission_paths_caption;
  default: { const unreachable: never = props.mode; throw new Error(`Unknown diagram mode: ${String(unreachable)}`); }
  }
});
defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <div class="access-scene" :class="'scene-' + mode" :data-docs-animation="'app-permissions-' + mode" :data-testid="'app-permissions-' + mode + '-diagram'" role="img" :aria-label="caption">
    <template v-if="mode === 'desktop'">
      <div class="scene-eyebrow"><MonitorIcon :size="17" />{{ messages.ordinary_windows_desktop_program }}</div>
      <div class="authority"><UserRoundIcon :size="16" />{{ messages.signed_in_user }}</div>
      <div class="scene-flow">
        <div class="node"><FileTextIcon :size="21" /><strong>{{ messages.readable_user_file }}</strong><code>{{ messages.desktop_example_file_name }}</code><span class="sample">{{ messages.draft_text_sample }}</span></div>
        <ArrowRightIcon class="flow-arrow" :size="20" />
        <div class="node node--destination"><AppWindowIcon :size="21" /><strong>{{ messages.desktop_app_or_cli }}</strong><span class="received">{{ messages.draft_text_sample }}</span></div>
      </div>
      <div class="path-track"><span class="moving-chip">{{ messages.draft_text_sample }}</span><ArrowRightIcon class="track-end" :size="17" /></div>
      <p class="scene-result">{{ messages.file_content_reaches_program }} <span>{{ messages.file_protection_limit }}</span></p>
    </template>

    <template v-else-if="mode === 'mobile'">
      <div class="scene-eyebrow"><SmartphoneIcon :size="17" />{{ messages.android_app_example }}</div>
      <div class="mobile-routes">
        <div class="mobile-route route-blocked">
          <div class="scene-flow">
            <div class="node"><FolderClosedIcon :size="20" /><strong>{{ messages.another_apps_private_data }}</strong></div>
            <ShieldIcon class="flow-arrow" :size="20" />
            <div class="node node--protected"><SmartphoneIcon :size="20" /><strong>{{ messages.this_mobile_app }}</strong><span class="received">{{ messages.blocked_by_app_sandbox }}</span></div>
          </div>
          <div class="path-track path-track--blocked"><span class="moving-chip">{{ messages.private_app_data }}</span><ShieldIcon class="track-stop" :size="21" /></div>
        </div>
        <div class="mobile-route route-sensor">
          <div class="scene-flow">
            <div class="node"><ActivityIcon :size="20" /><strong>{{ messages.raw_accelerometer_readings }}</strong><span class="sample">{{ messages.accelerometer_sample_value }}</span></div>
            <ArrowRightIcon class="flow-arrow" :size="20" />
            <div class="node node--destination"><SmartphoneIcon :size="20" /><strong>{{ messages.this_mobile_app }}</strong><span class="received">{{ messages.accelerometer_sample_value }}</span></div>
          </div>
          <div class="path-track"><span class="moving-chip">{{ messages.accelerometer_sample_value }}</span><ArrowRightIcon class="track-end" :size="17" /></div>
        </div>
      </div>
      <p class="scene-result">{{ messages.sensor_without_dedicated_prompt }}</p>
    </template>

    <template v-else-if="mode === 'web'">
      <div class="scene-eyebrow"><GlobeIcon :size="17" />{{ messages.ordinary_web_page_example }}</div>
      <div class="scene-flow scene-flow--three">
        <div class="node"><FileTextIcon :size="20" /><strong>{{ messages.user_selected_file }}</strong><code>{{ messages.web_example_file_name }}</code></div>
        <ArrowRightIcon class="flow-arrow" :size="18" />
        <div class="node node--browser"><FolderClosedIcon :size="20" /><strong>{{ messages.browser_file_selection }}</strong><span class="sample">{{ messages.web_example_file_name }}</span></div>
        <ArrowRightIcon class="flow-arrow" :size="18" />
        <div class="node node--destination"><AppWindowIcon :size="20" /><strong>{{ messages.web_page }}</strong><span class="received">{{ messages.selected_file_received }}</span></div>
      </div>
      <div class="path-track path-track--web"><span class="moving-chip">{{ messages.web_example_file_name }}</span><span class="browser-marker" /><ArrowRightIcon class="track-end" :size="17" /></div>
      <p class="scene-result"><ShieldIcon :size="16" />{{ messages.unselected_files_outside_scope }}</p>
    </template>

    <template v-else-if="mode === 'send'">
      <div class="send-routes">
        <div class="send-route send-route--desktop">
          <div class="scene-flow scene-flow--three">
            <div class="node"><FileTextIcon :size="18" /><strong>{{ messages.readable_example_file }}</strong><span class="sample">{{ messages.draft_text_sample }}</span></div>
            <ArrowRightIcon class="flow-arrow" :size="17" />
            <div class="node"><MonitorIcon :size="18" /><strong>{{ messages.desktop_program }}</strong></div>
            <ArrowRightIcon class="flow-arrow" :size="17" />
            <div class="node node--destination"><GlobeIcon :size="18" /><strong>{{ messages.example_service }}</strong><span class="received">{{ messages.draft_text_sample }}</span></div>
          </div>
          <div class="path-track"><span class="moving-chip">{{ messages.draft_text_sample }}</span><ArrowRightIcon class="track-end" :size="17" /></div>
        </div>
        <div class="send-route send-route--mobile">
          <div class="scene-flow scene-flow--three">
            <div class="node"><ActivityIcon :size="18" /><strong>{{ messages.accelerometer_reading }}</strong><span class="sample">{{ messages.accelerometer_sample_value }}</span></div>
            <ArrowRightIcon class="flow-arrow" :size="17" />
            <div class="node"><SmartphoneIcon :size="18" /><strong>{{ messages.android_app }}</strong></div>
            <ArrowRightIcon class="flow-arrow" :size="17" />
            <div class="node node--destination"><GlobeIcon :size="18" /><strong>{{ messages.example_service }}</strong><span class="received">{{ messages.accelerometer_sample_value }}</span></div>
          </div>
          <div class="path-track"><span class="moving-chip">{{ messages.accelerometer_sample_value }}</span><ArrowRightIcon class="track-end" :size="17" /></div>
        </div>
        <div class="send-route send-route--web">
          <div class="scene-flow scene-flow--three">
            <div class="node"><FileTextIcon :size="18" /><strong>{{ messages.selected_file_for_sending }}</strong><span class="sample">{{ messages.web_example_file_name }}</span></div>
            <ArrowRightIcon class="flow-arrow" :size="17" />
            <div class="node"><AppWindowIcon :size="18" /><strong>{{ messages.web_page_via_browser_http }}</strong></div>
            <ArrowRightIcon class="flow-arrow" :size="17" />
            <div class="node node--destination"><GlobeIcon :size="18" /><strong>{{ messages.example_service }}</strong><span class="received">{{ messages.web_example_file_name }}</span></div>
          </div>
          <div class="path-track"><span class="moving-chip">{{ messages.web_example_file_name }}</span><ArrowRightIcon class="track-end" :size="17" /></div>
        </div>
      </div>
    </template>

    <template v-else>
      <div class="scene-eyebrow"><WaypointsIcon :size="17" />{{ messages.android_permission_paths }}</div>
      <div class="permission-lanes">
        <div class="permission-lane">
          <div class="lane-head"><GlobeIcon :size="19" /><strong>{{ messages.internet_connection }}</strong><small>{{ messages.no_runtime_approval_dialog }}</small></div>
          <div class="permission-flow"><span>{{ messages.developer_declares_permission }}</span><ArrowRightIcon :size="17" /><span>{{ messages.os_grants_automatically }}</span><ArrowRightIcon :size="17" /><b>{{ messages.connection_possible }}</b></div>
        </div>
        <div class="permission-lane">
          <div class="lane-head"><MicIcon :size="19" /><strong>{{ messages.microphone_recording }}</strong><small>{{ messages.runtime_approval_prompt }}</small></div>
          <div class="permission-flow"><span>{{ messages.developer_declares_permission }}</span><ArrowRightIcon :size="17" /><span>{{ messages.android_asks_user }}</span><ArrowRightIcon :size="17" /><b>{{ messages.recording_after_approval }}</b></div>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.access-scene {
  min-width: 0;
  padding: 18px;
  border: 1px solid var(--line-strong);
  border-radius: 16px;
  background: var(--surface-2);
  box-shadow: var(--panel-shadow);
  color: var(--text);
  font: 12px/1.55 ui-sans-serif,system-ui,sans-serif;
}
.scene-eyebrow {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
  color: var(--blue);
  font-size: 12px;
  font-weight: 800;
}
.scene-eyebrow svg,.authority svg {
  flex: none;
}
.authority {
  display: flex;
  align-items: center;
  gap: 7px;
  width: fit-content;
  max-width: 100%;
  margin-bottom: 10px;
  padding: 5px 9px;
  border: 1px solid var(--line);
  border-radius: 7px;
  background: var(--surface);
  color: var(--muted);
  font-size: 12px;
}
.scene-flow {
  display: grid;
  grid-template-columns: minmax(0,1fr) 22px minmax(0,1fr);
  align-items: stretch;
  gap: 9px;
  min-width: 0;
}
.scene-flow--three {
  grid-template-columns: minmax(0,1fr) 18px minmax(0,1fr) 18px minmax(0,1fr);
  gap: 6px;
}
.node {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  justify-content: center;
  gap: 4px;
  min-width: 0;
  min-height: 83px;
  padding: 10px 12px;
  border: 1px solid var(--line-strong);
  border-radius: 11px;
  background: var(--surface);
}
.node > svg {
  flex: none;
  color: var(--blue);
}
.node strong {
  font-size: 12px;
  font-weight: 750;
  line-height: 1.45;
  overflow-wrap: anywhere;
}
.node code {
  color: var(--muted);
  font-size: 12px;
  overflow-wrap: anywhere;
}
.node--browser {
  border-color: color-mix(in srgb,var(--blue) 45%,var(--line-strong));
}
.node--destination {
  border-color: color-mix(in srgb,var(--green) 45%,var(--line-strong));
  background: color-mix(in srgb,var(--green) 5%,var(--surface));
}
.node--destination > svg {
  color: var(--green);
}
.node--protected {
  border-color: color-mix(in srgb,var(--blue) 45%,var(--line-strong));
  background: color-mix(in srgb,var(--blue) 6%,var(--surface));
}
.sample,.received {
  display: block;
  min-width: 0;
  padding: 3px 6px;
  border-radius: 5px;
  font-size: 12px;
  line-height: 1.4;
  overflow-wrap: anywhere;
}
.sample {
  background: var(--surface-3);
  color: var(--text);
}
.received {
  background: color-mix(in srgb,var(--green) 13%,var(--surface));
  color: var(--text);
}
.node--protected .received {
  background: color-mix(in srgb,var(--blue) 13%,var(--surface));
}
.flow-arrow {
  align-self: center;
  justify-self: center;
  color: var(--blue);
}
.path-track {
  position: relative;
  height: 32px;
  margin-top: 7px;
}
.path-track::before {
  position: absolute;
  top: 15px;
  right: 10px;
  left: 0;
  height: 2px;
  background: color-mix(in srgb,var(--blue) 55%,var(--line));
  content: "";
}
.moving-chip {
  position: absolute;
  z-index: 1;
  top: 2px;
  left: calc(100% - 83px);
  display: grid;
  place-items: center;
  width: 78px;
  min-height: 25px;
  padding: 1px 3px;
  border: 1px solid var(--blue);
  border-radius: 7px;
  background: var(--surface);
  color: var(--text);
  font-size: 11px;
  font-weight: 750;
  text-align: center;
  white-space: nowrap;
  box-shadow: 0 2px 6px #0002;
}
.track-end {
  position: absolute;
  top: 7px;
  right: -1px;
  color: var(--blue);
}
.track-stop {
  position: absolute;
  z-index: 2;
  top: 5px;
  right: 33%;
  padding: 3px;
  box-sizing: content-box;
  border-radius: 50%;
  background: var(--surface-2);
  color: var(--blue);
}
.path-track--blocked::before {
  background: linear-gradient(90deg,color-mix(in srgb,var(--blue) 60%,var(--line)) 65%,var(--line) 65%);
}
.path-track--blocked .moving-chip {
  left: calc(67% - 105px);
}
.browser-marker {
  position: absolute;
  top: 9px;
  left: 50%;
  width: 1px;
  height: 15px;
  background: var(--blue);
  opacity: .65;
}
.scene-result {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  margin: 8px 0 0;
  font-size: 12px;
  font-weight: 700;
}
.scene-result svg {
  flex: none;
  color: var(--green);
}
.scene-result span {
  color: var(--muted);
  font-weight: 400;
}
.mobile-routes,.send-routes {
  display: grid;
  gap: 13px;
}
.mobile-route,.send-route {
  min-width: 0;
  padding: 11px;
  border: 1px solid var(--line);
  border-radius: 12px;
  background: var(--surface);
}
.mobile-route .node,.send-route .node {
  min-height: 77px;
}
.send-route .node {
  padding: 8px;
}
.send-route .path-track {
  margin-top: 5px;
}
.permission-lanes {
  display: grid;
  gap: 11px;
}
.permission-lane {
  min-width: 0;
  padding: 12px;
  border: 1px solid var(--line-strong);
  border-radius: 11px;
  background: var(--surface);
}
.lane-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
}
.lane-head svg {
  flex: none;
  color: var(--blue);
}
.lane-head strong {
  font-size: 13px;
}
.lane-head small {
  margin-left: auto;
  color: var(--muted);
  font-size: 12px;
}
.permission-flow {
  display: grid;
  grid-template-columns: minmax(0,1fr) 18px minmax(0,1fr) 18px minmax(0,1fr);
  align-items: center;
  gap: 7px;
}
.permission-flow span,.permission-flow b {
  min-width: 0;
  padding: 9px;
  border-radius: 7px;
  background: var(--surface-3);
  font-size: 12px;
  line-height: 1.5;
  text-align: center;
  overflow-wrap: anywhere;
}
.permission-flow b {
  background: color-mix(in srgb,var(--green) 12%,var(--surface));
  color: var(--text);
}
.permission-flow svg {
  justify-self: center;
  color: var(--blue);
}
.scene-desktop .moving-chip,.scene-web .moving-chip {
  animation: travel 8s ease-in-out infinite;
}
.scene-mobile .route-blocked .moving-chip {
  animation: travel-blocked 10s ease-in-out infinite;
}
.scene-mobile .route-sensor .moving-chip {
  animation: travel-sensor 10s ease-in-out infinite;
}
.send-route--desktop .moving-chip {
  animation: travel 12s ease-in-out infinite;
}
.send-route--mobile .moving-chip {
  animation: travel 12s ease-in-out -4s infinite;
}
.send-route--web .moving-chip {
  animation: travel 12s ease-in-out -8s infinite;
}
.scene-desktop .received,.scene-web .received {
  animation: result-arrive 8s ease-in-out infinite;
}
.route-sensor .received {
  animation: result-arrive-sensor 10s ease-in-out infinite;
}
.send-route--desktop .received {
  animation: result-arrive 12s ease-in-out infinite;
}
.send-route--mobile .received {
  animation: result-arrive 12s ease-in-out -4s infinite;
}
.send-route--web .received {
  animation: result-arrive 12s ease-in-out -8s infinite;
}
.permission-flow span:first-child,.permission-flow span:nth-of-type(2),.permission-flow b {
  animation: permission-step 9s ease-in-out infinite;
}
.permission-flow span:nth-of-type(2) {
  animation-delay: 3s;
}
.permission-flow b {
  animation-delay: 6s;
}
@keyframes travel {
  0%,10% {
    left: 0;
    opacity: 0;
  }
  20% {
    opacity: 1;
  }
  60%,88% {
    left: calc(100% - 83px);
    opacity: 1;
  }
  100% {
    opacity: 0;
  }
}
@keyframes travel-blocked {
  0%,9% {
    left: 0;
    opacity: 0;
  }
  17% {
    opacity: 1;
  }
  34%,56% {
    left: calc(67% - 105px);
    opacity: 1;
  }
  64%,100% {
    left: calc(67% - 105px);
    opacity: 0;
  }
}
@keyframes travel-sensor {
  0%,45% {
    left: 0;
    opacity: 0;
  }
  53% {
    opacity: 1;
  }
  76%,92% {
    left: calc(100% - 83px);
    opacity: 1;
  }
  100% {
    opacity: 0;
  }
}
@keyframes result-arrive {
  0%,54% {
    box-shadow: none;
  }
  65%,82% {
    box-shadow: 0 0 0 3px color-mix(in srgb,var(--green) 25%,transparent);
  }
  100% {
    box-shadow: none;
  }
}
@keyframes result-arrive-sensor {
  0%,72% {
    box-shadow: none;
  }
  79%,93% {
    box-shadow: 0 0 0 3px color-mix(in srgb,var(--green) 25%,transparent);
  }
  100% {
    box-shadow: none;
  }
}
@keyframes permission-step {
  0%,30% {
    box-shadow: 0 0 0 3px color-mix(in srgb,var(--blue) 23%,transparent);
  }
  37%,100% {
    box-shadow: none;
  }
}
html:has(#docs-pause-motion:checked) .access-scene *, html:has(#docs-pause-motion:checked) .access-scene *::before, html:has(#docs-pause-motion:checked) .access-scene *::after {
  animation: none!important;
}
@media(prefers-reduced-motion:reduce) {
  .access-scene *, .access-scene *::before, .access-scene *::after {
    animation: none!important;
  }
}
@media(max-width:620px) {
  .access-scene {
    padding: 13px;
  }
  .scene-flow {
    gap: 6px;
  }
  .scene-flow--three {
    grid-template-columns: minmax(0,1fr) 14px minmax(0,1fr) 14px minmax(0,1fr);
    gap: 3px;
  }
  .scene-flow--three .node {
    padding: 8px 6px;
  }
  .scene-flow--three .node strong,.scene-flow--three .sample,.scene-flow--three .received {
    font-size: 12px;
  }
  .mobile-route,.send-route {
    padding: 8px;
  }
  .lane-head {
    flex-wrap: wrap;
  }
  .lane-head small {
    margin-left: 0;
  }
  .permission-flow {
    grid-template-columns: minmax(0,1fr);
    gap: 5px;
  }
  .permission-flow svg {
    transform: rotate(90deg);
  }
  .permission-flow span,.permission-flow b {
    padding: 8px;
    text-align: left;
  }
}
</style>
