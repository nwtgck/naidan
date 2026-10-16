<script setup lang="ts">
import { computed } from 'vue';
import { ArrowRightIcon, Globe2Icon, PanelTopIcon, ServerIcon, ShieldXIcon } from 'lucide-vue-next';
import type { messages as englishMessages } from '../../pages/csp-editions/messages/en';

const props = defineProps<{ messages: typeof englishMessages }>();

const editions = computed(() => [
  {
    key: 'local-only',
    title: props.messages.versions_local_only_title,
    hostname: 'naidan-local-only.pages.dev',
    localState: 'allowed',
    localStatus: props.messages.permitted_by_csp,
    externalState: 'blocked',
    externalStatus: props.messages.blocked_by_csp,
    externalExample: props.messages.external_model_download,
    selfStatus: props.messages.own_site_allowed,
  },
  {
    key: 'curated',
    title: props.messages.versions_curated_title,
    hostname: 'naidan-curated.pages.dev',
    localState: 'allowed',
    localStatus: props.messages.permitted_by_csp,
    externalState: 'allowed',
    externalStatus: props.messages.permitted_by_csp,
    externalExample: props.messages.curated_external_services,
    selfStatus: props.messages.own_site_allowed,
  },
  {
    key: 'standard',
    title: props.messages.versions_standard_title,
    hostname: 'naidan.pages.dev',
    localState: 'standard',
    localStatus: props.messages.standard_connection_limit,
    externalState: 'standard',
    externalStatus: props.messages.standard_connection_limit,
    externalExample: props.messages.external_model_download,
    selfStatus: props.messages.no_added_connection_limit,
  },
] as const);


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
  <div class="policy-map" data-testid="connection-policy-diagram" data-docs-animation="connection-policy">
    <div class="map-heading"><strong>{{ messages.connection_destinations_title }}</strong><code>connect-src</code></div>
    <div v-for="edition in editions" :key="edition.key" class="policy-row" :data-edition="edition.key">
      <div class="page-box">
        <div class="page-label"><PanelTopIcon :size="18" aria-hidden="true" /><span>{{ messages.browser_page }}</span></div>
        <strong>{{ edition.title }}</strong>
        <code>{{ edition.hostname }}</code>
        <span class="self-status">{{ edition.selfStatus }}</span>
      </div>
      <div class="branch-stem" aria-hidden="true"><span /><span /></div>
      <div class="branch-routes" data-testid="policy-branches">
        <div class="route" :data-state="edition.localState" data-destination="local" data-source="page">
          <div class="route-connector" aria-hidden="true"><span class="draw-line" /><ArrowRightIcon :size="16" /></div>
          <div class="target-box">
            <ServerIcon :size="19" aria-hidden="true" />
            <div class="target-text"><strong>{{ messages.local_ai_server }}</strong><code>localhost / 127.0.0.1</code><span class="route-status">{{ edition.localStatus }}</span></div>
          </div>
        </div>
        <div class="route" :data-state="edition.externalState" data-destination="external" data-source="page">
          <div class="route-connector" aria-hidden="true"><span class="draw-line" /><ShieldXIcon v-if="edition.externalState === 'blocked'" :size="18" /><ArrowRightIcon v-else :size="16" /></div>
          <div class="target-box">
            <Globe2Icon :size="19" aria-hidden="true" />
            <div class="target-text"><strong>{{ messages.external_services }}</strong><span class="target-example">{{ edition.externalExample }}</span><span class="route-status">{{ edition.externalStatus }}</span></div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.policy-map {
  min-width: 0;
  padding: 18px;
  border: 1px solid var(--line-strong);
  border-radius: 16px;
  background: var(--surface);
  font: 13px/1.55 ui-sans-serif,system-ui,sans-serif;
}
.map-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 13px;
  color: var(--text);
}
.map-heading strong {
  font-size: 15px;
  line-height: 1.5;
}
.map-heading code {
  flex: none;
  padding: 3px 7px;
  border: 1px solid var(--line-strong);
  border-radius: 6px;
  color: var(--muted);
  font-size: 11px;
}
.policy-row {
  display: grid;
  grid-template-columns: minmax(0,180px) 28px minmax(0,1fr);
  align-items: stretch;
  padding: 12px;
  border: 1px solid var(--line);
  border-radius: 12px;
  background: var(--bg);
  --edition-delay:0s;
}
.policy-row + .policy-row {
  margin-top: 9px;
}
.policy-row[data-edition="curated"] {
  --edition-delay:1.2s;
}
.policy-row[data-edition="standard"] {
  --edition-delay:2.4s;
}
.page-box,.target-box {
  min-width: 0;
}
.page-box {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 11px 12px;
  border: 1px solid var(--line-strong);
  border-radius: 9px;
  background: var(--surface-2);
}
.page-label {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--blue);
  font-size: 11px;
}
.page-label svg {
  flex: none;
}
.page-box strong {
  color: var(--text);
  font-size: 13px;
  line-height: 1.45;
}
.page-box code {
  color: var(--muted);
  font-size: 10px;
  overflow-wrap: anywhere;
}
.self-status {
  margin-top: auto;
  color: var(--subtle);
  font-size: 11px;
  line-height: 1.5;
}
.branch-stem {
  position: relative;
  min-width: 0;
}
.branch-stem::before {
  position: absolute;
  top: calc(25% - 2.5px);
  bottom: calc(25% - 2.5px);
  left: 14px;
  border-left: 1px solid var(--line-strong);
  content: "";
}
.branch-stem::after {
  position: absolute;
  top: 50%;
  right: 14px;
  left: 0;
  border-top: 1px solid var(--line-strong);
  content: "";
}
.branch-stem span {
  position: absolute;
  right: 0;
  left: 14px;
  border-top: 1px solid var(--line-strong);
}
.branch-stem span:first-child {
  top: calc(25% - 2.5px);
}
.branch-stem span:last-child {
  top: calc(75% + 2.5px);
}
.branch-routes {
  display: grid;
  grid-template-rows: repeat(2,minmax(0,1fr));
  gap: 10px;
  min-width: 0;
}
.route {
  display: flex;
  align-items: stretch;
  min-width: 0;
  --route-color:var(--blue);
  --lane-delay:0s;
}
.route[data-destination="external"] {
  --lane-delay:.45s;
}
.route[data-state="blocked"] {
  --route-color:var(--subtle);
}
.route[data-state="standard"] {
  --route-color:var(--muted);
}
.route-connector {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  flex: none;
  width: 40px;
  color: var(--route-color);
}
.route-connector::before {
  position: absolute;
  top: 50%;
  right: 5px;
  left: 0;
  border-top: 1px solid var(--line-strong);
  content: "";
}
.draw-line {
  position: absolute;
  top: calc(50% - 1px);
  right: 12px;
  left: 0;
  height: 2px;
  background: var(--route-color);
  transform-origin: left;
  animation: draw-policy-path 16s ease-out infinite both;
  animation-delay: calc(var(--edition-delay) + var(--lane-delay));
}
.route-connector svg {
  position: relative;
  z-index: 1;
  flex: none;
  background: var(--bg);
}
.route[data-state="blocked"] .draw-line {
  right: 17px;
}
.route[data-state="blocked"] .route-connector::before {
  right: 17px;
}
.route[data-state="blocked"] .route-connector svg {
  animation: mark-policy-stop 16s ease-out infinite both;
  animation-delay: calc(var(--edition-delay) + var(--lane-delay));
}
.target-box {
  display: flex;
  gap: 9px;
  align-items: flex-start;
  flex: 1;
  padding: 11px 10px;
  border: 1px solid var(--line-strong);
  border-radius: 9px;
  background: var(--surface);
}
.target-box > svg {
  flex: none;
  margin-top: 2px;
  color: var(--route-color);
}
.target-text {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}
.target-text strong {
  color: var(--text);
  font-size: 13px;
  line-height: 1.45;
}
.target-text code,.target-example {
  color: var(--muted);
  font-size: 12px;
  line-height: 1.5;
  overflow-wrap: anywhere;
}
.route-status {
  margin-top: 3px;
  color: var(--route-color);
  font-size: 12px;
  font-weight: 700;
  line-height: 1.5;
}
.route[data-state="blocked"] .target-box {
  border-style: dashed;
}
.route[data-state="blocked"] .route-status {
  color: var(--text);
}
@keyframes draw-policy-path {
  0%,3% {
    transform: scaleX(0);
  }
  9%,100% {
    transform: scaleX(1);
  }
}
@keyframes mark-policy-stop {
  0%,5%,10%,100% {
    transform: scale(1);
  }
  7% {
    transform: scale(1.18);
  }
}
@media(max-width:760px) {
  .policy-row {
    grid-template-columns: 32px minmax(0,1fr);
    grid-template-rows: auto auto;
    gap: 8px 0;
  }
  .page-box {
    padding: 10px 12px;
  }
  .page-box code {
    font-size: 11px;
  }
  .page-box {
    grid-column: 1 / -1;
  }
  .branch-stem {
    grid-column: 1;
    grid-row: 2;
  }
  .branch-stem::before {
    top: -8px;
    left: 16px;
  }
  .branch-stem::after {
    display: none;
  }
  .branch-stem span {
    left: 16px;
  }
  .branch-routes {
    grid-column: 2;
    grid-row: 2;
  }
  .route-connector {
    width: 32px;
  }
}
@media(max-width:400px) {
  .policy-map {
    padding: 12px;
  }
  .policy-row {
    padding: 9px;
  }
  .target-box {
    padding: 10px 8px;
  }
}
@media(prefers-reduced-motion:reduce) {
  .policy-map .draw-line,.policy-map .route-connector svg {
    animation: none!important;
    transform: none;
    opacity: 1;
  }
}
:global(html:has(#docs-pause-motion:checked) [data-docs-animation="connection-policy"] .draw-line),
:global(html:has(#docs-pause-motion:checked) [data-docs-animation="connection-policy"] .route-connector svg) {
  animation: none!important;
  transform: none;
  opacity: 1;
}
</style>
