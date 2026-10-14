<script setup lang="ts">
import type { InheritanceGuideMessages } from '../messages';

defineProps<{ copy: InheritanceGuideMessages['concept']['diagram'] }>();

type NodeState = {
  slot: 'global' | 'group' | 'chatA' | 'chatB';
  endpoint: 'a' | 'b';
  model: 'a1' | 'a2' | 'b1' | 'b2';
  endpointSource: 'here' | 'global' | 'group';
  modelSource: 'here' | 'global' | 'group';
};

type Phase = {
  id: 'shared' | 'globalChange' | 'groupChange' | 'chatChange';
  nodes: readonly [NodeState, NodeState, NodeState, NodeState];
};

const phases = [
  {
    id: 'shared',
    nodes: [
      { slot: 'global', endpoint: 'a', model: 'a1', endpointSource: 'here', modelSource: 'here' },
      { slot: 'group', endpoint: 'a', model: 'a1', endpointSource: 'global', modelSource: 'global' },
      { slot: 'chatA', endpoint: 'a', model: 'a1', endpointSource: 'global', modelSource: 'global' },
      { slot: 'chatB', endpoint: 'a', model: 'a1', endpointSource: 'global', modelSource: 'global' },
    ],
  },
  {
    id: 'globalChange',
    nodes: [
      { slot: 'global', endpoint: 'a', model: 'a2', endpointSource: 'here', modelSource: 'here' },
      { slot: 'group', endpoint: 'a', model: 'a2', endpointSource: 'global', modelSource: 'global' },
      { slot: 'chatA', endpoint: 'a', model: 'a2', endpointSource: 'global', modelSource: 'global' },
      { slot: 'chatB', endpoint: 'a', model: 'a2', endpointSource: 'global', modelSource: 'global' },
    ],
  },
  {
    id: 'groupChange',
    nodes: [
      { slot: 'global', endpoint: 'a', model: 'a2', endpointSource: 'here', modelSource: 'here' },
      { slot: 'group', endpoint: 'b', model: 'b1', endpointSource: 'here', modelSource: 'here' },
      { slot: 'chatA', endpoint: 'b', model: 'b1', endpointSource: 'group', modelSource: 'group' },
      { slot: 'chatB', endpoint: 'b', model: 'b1', endpointSource: 'group', modelSource: 'group' },
    ],
  },
  {
    id: 'chatChange',
    nodes: [
      { slot: 'global', endpoint: 'a', model: 'a2', endpointSource: 'here', modelSource: 'here' },
      { slot: 'group', endpoint: 'b', model: 'b1', endpointSource: 'here', modelSource: 'here' },
      { slot: 'chatA', endpoint: 'b', model: 'b1', endpointSource: 'group', modelSource: 'group' },
      { slot: 'chatB', endpoint: 'b', model: 'b2', endpointSource: 'group', modelSource: 'here' },
    ],
  },
] as const satisfies readonly Phase[];

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <div class="inheritance-diagram" data-docs-animation="inheritance-concept" data-testid="inheritance-concept" aria-hidden="true">
    <div v-for="phase in phases" :key="phase.id" class="phase" :class="`phase-${phase.id}`" :data-testid="`inheritance-concept-${phase.id}`">
      <div class="phase-title">{{ copy.phases[phase.id] }}</div>
      <template v-for="(node, index) in phase.nodes" :key="node.slot">
        <div v-if="index === 1" class="flow-arrow" aria-hidden="true">↓</div>
        <div v-else-if="index === 2" class="flow-arrow" aria-hidden="true">↙ ↘</div>
        <div class="node" :class="`node-${node.slot}`" :data-testid="`inheritance-node-${phase.id}-${node.slot}`">
          <strong class="node-title">{{ copy.nodes[node.slot] }}</strong>
          <div class="setting-row">
            <span class="setting-label">{{ copy.endpointLabel }}</span>
            <strong class="setting-value">{{ copy.endpoints[node.endpoint] }}</strong>
            <span class="setting-source" :class="{ 'source-local': node.endpointSource === 'here' }">{{ copy.sources[node.endpointSource] }}</span>
          </div>
          <div class="setting-row">
            <span class="setting-label">{{ copy.modelLabel }}</span>
            <strong class="setting-value">{{ copy.models[node.model] }}</strong>
            <span class="setting-source" :class="{ 'source-local': node.modelSource === 'here' }">{{ copy.sources[node.modelSource] }}</span>
          </div>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.inheritance-diagram { display:grid;width:100%;max-width:680px;margin-inline:auto;overflow:hidden;border:1px solid var(--line-strong);border-radius:16px;background:var(--surface);box-shadow:var(--panel-shadow);color:var(--text); }
.phase { grid-area:1/1;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));align-content:start;gap:7px 10px;padding:16px;opacity:0;visibility:hidden;animation-duration:20s;animation-timing-function:linear;animation-iteration-count:infinite; }
.phase-shared { opacity:1;visibility:visible;animation-name:show-shared; }
.phase-globalChange { animation-name:show-global-change; }
.phase-groupChange { animation-name:show-group-change; }
.phase-chatChange { animation-name:show-chat-change; }
.phase-title { grid-column:1/-1;display:flex;align-items:center;min-height:30px;padding:5px 10px;border-radius:9px;background:color-mix(in srgb,var(--blue) 11%,var(--surface));color:var(--blue);font-size:13px;font-weight:750;line-height:1.35; }
.flow-arrow { grid-column:1/-1;height:14px;color:var(--blue);font-size:15px;font-weight:800;line-height:14px;text-align:center; }
.node { min-width:0;padding:8px 12px;border:1px solid var(--line-strong);border-radius:10px;background:var(--surface-2); }
.node-global,.node-group { grid-column:1/-1;width:min(100%,520px);margin-inline:auto; }
.node-chatA { grid-column:1; }
.node-chatB { grid-column:2; }
.node-title { display:block;margin-bottom:4px;font-size:13px;line-height:1.35; }
.setting-row { display:grid;grid-template-columns:minmax(0,76px) minmax(0,1fr) auto;align-items:baseline;gap:5px;min-width:0;font-size:11px;line-height:1.5; }
.setting-label { color:var(--muted); }
.setting-value { min-width:0;overflow-wrap:anywhere; }
.setting-source { padding:1px 5px;border-radius:7px;background:color-mix(in srgb,var(--blue) 9%,var(--surface-2));color:var(--muted);font-size:10px;white-space:nowrap; }
.setting-source.source-local { color:var(--blue); }
@keyframes show-shared { 0%,23% { opacity:1;visibility:visible; } 25%,100% { opacity:0;visibility:hidden; } }
@keyframes show-global-change { 0%,24% { opacity:0;visibility:hidden; } 26%,48% { opacity:1;visibility:visible; } 50%,100% { opacity:0;visibility:hidden; } }
@keyframes show-group-change { 0%,49% { opacity:0;visibility:hidden; } 51%,73% { opacity:1;visibility:visible; } 75%,100% { opacity:0;visibility:hidden; } }
@keyframes show-chat-change { 0%,74% { opacity:0;visibility:hidden; } 76%,100% { opacity:1;visibility:visible; } }
@media(max-width:560px) {
  .phase { grid-template-columns:minmax(0,1fr);gap:6px;padding:12px; }
  .phase-title,.flow-arrow,.node-global,.node-group,.node-chatA,.node-chatB { grid-column:1; }
  .phase-title { min-height:36px; }
  .flow-arrow { height:10px;font-size:12px;line-height:10px; }
  .node { width:100%;padding:7px 9px; }
  .node-title { margin-bottom:2px; }
  .setting-row { grid-template-columns:minmax(0,78px) minmax(0,1fr) auto; }
}
:global(html:has(#docs-pause-motion:checked) .inheritance-diagram .phase) { animation:none!important;opacity:0;visibility:hidden; }
:global(html:has(#docs-pause-motion:checked) .inheritance-diagram .phase-chatChange) { opacity:1;visibility:visible; }
@media(prefers-reduced-motion:reduce) {
  .phase { animation:none!important;opacity:0;visibility:hidden; }
  .phase-chatChange { opacity:1;visibility:visible; }
}
</style>
