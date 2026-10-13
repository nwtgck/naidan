<script setup lang="ts">
// Labels are intentionally English, matching the source-based visual examples.
// The surrounding localized prose gives the complete, stationary explanation.


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
  <div class="boundary-map" data-docs-animation="local-processing" lang="en" aria-hidden="true">
    <div class="boundary-legend"><span class="device-dot" />YOUR DEVICE <span class="legend-note">Local processing</span></div>
    <div class="browser-boundary">
      <div class="boundary-label"><span>Browser sandbox</span><span class="small-shield">◇</span></div>
      <div class="local-pipeline">
        <div class="pipeline-node"><span class="node-number">01</span><b>Your input</b><div class="paper-stack"><i /><i /><i /></div><small>Text · Selected files</small></div>
        <div class="pipeline-track"><i /></div>
        <div class="pipeline-node model-node"><span class="node-number">02</span><b>Local model</b><div class="compute-grid"><i v-for="cell in 9" :key="cell" :style="{ '--cell': cell }" /></div><small>WebGPU / WebAssembly</small></div>
        <div class="pipeline-track"><i /></div>
        <div class="pipeline-node output-node"><span class="node-number">03</span><b>Response</b><div class="output-lines"><i /><i /><i /></div><small>Text · Images · Speech</small></div>
      </div>
      <div class="boundary-bottom"><span class="boundary-check">✓</span><span>The input stays in this processing loop</span></div>
    </div>
    <div class="download-lane"><span class="download-path">↓</span><span><b>Model download</b><small>Contacts the model distributor during setup</small></span><span class="download-icon">⇣</span></div>
  </div>
</template>

<style scoped>
.boundary-map {
  border: 1px solid var(--line-strong);
  border-radius: 20px;
  background: var(--surface);
  padding: 25px;
}

.boundary-legend {
  display: flex;
  align-items: center;
  gap: 9px;
  font: 700 10px/1.5 ui-sans-serif, system-ui, sans-serif;
  letter-spacing: .09em;
  color: var(--muted);
  margin-bottom: 20px;
}

.device-dot {
  width: 6px;
  height: 6px;
  border-radius: 100%;
  background: var(--green);
}

.legend-note {
  margin-left: auto;
  font-weight: 400;
  letter-spacing: 0;
}

.browser-boundary {
  border: 1px solid #3b82f66b;
  border-radius: 13px;
  background: linear-gradient(145deg,#3b82f60b,transparent);
  padding: 18px;
}

.boundary-label {
  display: flex;
  justify-content: space-between;
  align-items: center;
  color: var(--blue);
  font: 600 12px/1.5 ui-sans-serif, system-ui, sans-serif;
}

.small-shield {
  font-size: 20px;
}

.local-pipeline {
  display: grid;
  grid-template-columns: 1fr 24px 1fr 24px 1fr;
  align-items: center;
  margin: 23px 0;
}

.pipeline-node {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  gap: 9px;
  min-width: 0;
  font: 12px/1.5 ui-sans-serif, system-ui, sans-serif;
}

.node-number {
  font-size: 9px;
  color: var(--subtle);
  font-variant-numeric: tabular-nums;
}

.pipeline-node b {
  font-weight: 600;
}

.pipeline-node small {
  font-size: 9px;
  color: var(--muted);
}

.pipeline-track {
  height: 1px;
  background: var(--line-strong);
  position: relative;
}

.pipeline-track i {
  position: absolute;
  top: -2px;
  left: 0;
  height: 5px;
  width: 6px;
  border-radius: 6px;
  background: var(--blue);
  animation: docs-packet 4s ease-in-out infinite;
}

.pipeline-track:nth-of-type(4) i {
  animation-delay: 1.3s;
}

.paper-stack {
  width: 42px;
  height: 40px;
  position: relative;
  margin: 4px 0;
}

.paper-stack i {
  position: absolute;
  width: 29px;
  height: 37px;
  border: 1px solid var(--line-strong);
  background: var(--surface-2);
  border-radius: 4px;
  left: 2px;
  top: 1px;
}

.paper-stack i:nth-child(2) {
  left: 7px;
  top: 3px;
}

.paper-stack i:last-child {
  left: 12px;
  top: 5px;
  border-color: var(--blue);
  background: linear-gradient(var(--blue),var(--blue)) center 12px/15px 1px no-repeat,linear-gradient(var(--blue),var(--blue)) center 18px/15px 1px no-repeat,var(--surface-2);
}

.compute-grid {
  display: grid;
  grid-template-columns: repeat(3,9px);
  gap: 4px;
  padding: 6px;
  border: 1px solid var(--line-strong);
  border-radius: 7px;
}

.compute-grid i {
  width: 9px;
  height: 9px;
  border-radius: 2px;
  background: var(--blue);
  animation: docs-compute 4s ease-in-out infinite;
  animation-delay: calc(var(--cell) * .14s);
}

.output-lines {
  display: flex;
  flex-direction: column;
  width: 50px;
  gap: 7px;
  margin: 9px 0;
}

.output-lines i {
  height: 4px;
  background: var(--green);
  border-radius: 5px;
  transform-origin: left;
  animation: docs-output 4s ease-in-out infinite;
}

.output-lines i:nth-child(2) {
  width: 90%;
  animation-delay: .2s;
}

.output-lines i:nth-child(3) {
  width: 60%;
  animation-delay: .4s;
}

.boundary-bottom {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding-top: 14px;
  border-top: 1px solid var(--line);
  font: 10px/1.6 ui-sans-serif, system-ui,sans-serif;
  color: var(--muted);
}

.boundary-check {
  color: var(--green);
}

.download-lane {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 18px;
  padding: 0 7px;
  font: 11px/1.6 ui-sans-serif, system-ui,sans-serif;
  color: var(--muted);
}

.download-lane b,.download-lane small {
  display: block;
}

.download-lane b {
  color: var(--text);
  font-weight: 500;
}

.download-lane small {
  font-size: 10px;
}

.download-icon {
  margin-left: auto;
  font-size: 23px;
}

.download-path {
  color: var(--subtle);
}

@keyframes docs-packet {
  0%,10% {
    transform: translateX(0);
    opacity: 0;
  }
  25% {
    opacity: 1;
  }
  70% {
    transform: translateX(20px);
    opacity: 1;
  }
  85%,100% {
    transform: translateX(20px);
    opacity: 0;
  }
}

@keyframes docs-compute {
  0%,80%,100% {
    opacity: .35;
  }
  30%,55% {
    opacity: 1;
  }
}

@keyframes docs-output {
  0%,20% {
    transform: scaleX(.4);
    opacity: .3;
  }
  60%,90% {
    transform: scaleX(1);
    opacity: 1;
  }
  100% {
    transform: scaleX(.4);
    opacity: .3;
  }
}

@media(max-width:600px) {
  .boundary-map {
    padding: 16px;
  }
  .browser-boundary {
    padding: 12px;
  }
  .pipeline-node {
    font-size: 10px;
  }
  .pipeline-node small {
    font-size: 8px;
  }
  .local-pipeline {
    grid-template-columns: 1fr 15px 1fr 15px 1fr;
  }
  .legend-note {
    display: none;
  }
  .pipeline-track i {
    width: 4px;
  }
  @keyframes docs-packet {
    0%,10% {
      transform: translateX(0);
      opacity: 0;
    }
    25% {
      opacity: 1;
    }
    70% {
      transform: translateX(12px);
      opacity: 1;
    }
    85%,100% {
      transform: translateX(12px);
      opacity: 0;
    }
  }
}
</style>
