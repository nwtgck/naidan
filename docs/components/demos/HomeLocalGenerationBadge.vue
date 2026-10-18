<script setup lang="ts">
import naidanLogo from '../../assets/naidan.svg';

defineProps<{ claim: string }>();

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <div class="local-overhead"><span class="local-overhead-badge"><span class="local-overhead-brand"><img :src="naidanLogo" width="18" height="18" alt=""><strong class="brand-wordmark">Naidan</strong></span><span class="local-overhead-claim">{{ claim }}</span></span></div>
</template>

<style scoped>
.local-overhead {
  grid-column: 1;
  grid-row: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  min-width: 0;
}
.local-overhead-badge {
  box-sizing: border-box;
  display: inline-flex;
  align-items: center;
  gap: 7px;
  max-width: 100%;
  padding: 7px 11px;
  border: 1px solid color-mix(in srgb,var(--blue) 30%,var(--line-strong));
  border-radius: 999px;
  background: color-mix(in srgb,var(--blue) 7%,var(--surface));
  color: var(--text);
  font-size: 12px;
  line-height: 1.35;
  font-weight: 750;
}
.local-overhead-brand {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex: none;
  white-space: nowrap;
}
.local-overhead-brand img {
  display: block;
  flex: none;
}
.local-overhead-brand strong {
  font-size: 14px;
}
.local-overhead-claim {
  min-width: 0;
  overflow-wrap: anywhere;
}
</style>
