<script setup lang="ts">
// Inline indicator shown at the frontier of actively generating content — no props needed.


defineExpose({
  __testOnly: {
    // Export internal state and logic used only for testing here. Do not reference these in production logic.
  }
});
</script>

<template>
  <span class="generating-indicator" aria-hidden="true" data-testid="generating-indicator">
    <span class="gi-p gi-p1" />
    <span class="gi-p gi-p2" />
    <span class="gi-p gi-p3" />
    <span class="gi-p gi-p4" />
  </span>
</template>

<style scoped>
.generating-indicator {
  display: inline-block;
  position: relative;
  width: 4px;
  height: 16px;
  overflow: visible;
  vertical-align: text-bottom;
  margin-left: -3px;
}

/* All particles originate from same point, burst simultaneously */
.gi-p {
  position: absolute;
  width: 5px;
  height: 5px;
  clip-path: polygon(50% 0%, 62% 38%, 100% 50%, 62% 62%, 50% 100%, 38% 62%, 0% 50%, 38% 38%);
  bottom: 4px;
  left: 0;
  opacity: 0;
}

.gi-p1 { background: #60a5fa; box-shadow: 0 0 4px 1px rgba(96, 165, 250, 0.6);  animation: gi-ur 0.7s ease-out infinite 0s;    }
.gi-p2 { background: #93c5fd; box-shadow: 0 0 4px 1px rgba(147, 197, 253, 0.6); animation: gi-r  0.7s ease-out infinite 0s;    }
.gi-p3 { background: #3b82f6; box-shadow: 0 0 4px 1px rgba(59, 130, 246, 0.6);  animation: gi-dr 0.7s ease-out infinite 0s;    }
.gi-p4 { background: #bfdbfe; box-shadow: 0 0 4px 1px rgba(191, 219, 254, 0.6); animation: gi-u  0.7s ease-out infinite 0.35s; }

/* Fan burst: tight spread, right-leaning — all fire together */
@keyframes gi-ur {
  0%   { opacity: 0; transform: translate(0, 0)        scale(0.4); }
  20%  { opacity: 1; transform: translate(7px, -5px)   scale(1.1); }
  100% { opacity: 0; transform: translate(18px, -9px)  scale(0.8); }
}
@keyframes gi-r {
  0%   { opacity: 0; transform: translate(0, 0)        scale(0.4); }
  20%  { opacity: 1; transform: translate(8px, -1px)   scale(1.1); }
  100% { opacity: 0; transform: translate(20px, -2px)  scale(0.8); }
}
@keyframes gi-dr {
  0%   { opacity: 0; transform: translate(0, 0)        scale(0.4); }
  20%  { opacity: 1; transform: translate(7px, 3px)    scale(1.1); }
  100% { opacity: 0; transform: translate(17px, 6px)   scale(0.8); }
}
@keyframes gi-u {
  0%   { opacity: 0; transform: translate(0, 0)        scale(0.4); }
  20%  { opacity: 1; transform: translate(5px, -7px)   scale(1.1); }
  100% { opacity: 0; transform: translate(11px, -16px) scale(0.8); }
}
</style>
