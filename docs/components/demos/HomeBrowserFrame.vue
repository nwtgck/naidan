<script setup lang="ts">
import { ArrowLeftIcon, RotateCwIcon, XIcon } from 'lucide-vue-next';
import naidanLogo from '../../assets/naidan.svg';

defineProps<{ identity: 'naidan' | 'generic'; tabLabel: string }>();

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <div class="browser-generation-scene">
    <div class="browser-chrome" aria-hidden="true">
      <div class="browser-tabs"><span class="browser-tab"><img v-if="identity === 'naidan'" :src="naidanLogo" width="12" height="12" alt=""><b>{{ tabLabel }}</b><XIcon :size="10" aria-hidden="true" /></span></div>
      <div class="browser-navigation"><ArrowLeftIcon :size="13" /><RotateCwIcon :size="13" /><span class="browser-address"><span class="address-mark" /><span class="address-line" /></span></div>
    </div>
    <slot />
  </div>
</template>

<style scoped>
.browser-generation-scene { position:relative;z-index:1;box-sizing:border-box;min-width:0;overflow:hidden;border:1px solid var(--line-strong);border-radius:15px;background:var(--surface-2);color:var(--text);box-shadow:var(--panel-shadow); }
.browser-generation-scene :deep(*) { box-sizing:border-box; }
.browser-chrome { border-bottom:1px solid var(--line-strong);background:var(--surface-2); }
.browser-tabs { display:flex;align-items:center;gap:8px;min-height:27px;padding:4px 10px 0;border-bottom:1px solid var(--line-strong); }
.browser-tab { display:inline-flex;align-items:center;gap:6px;min-width:76px;padding:3px 7px;border-radius:6px 6px 0 0;background:var(--bg);color:var(--muted);font-size:11px;line-height:1.5; }
.browser-tab b { font-weight:500; }
.browser-tab img { display:block;flex:none; }
.browser-tab svg { flex:none;margin-left:13px;color:var(--subtle); }
.browser-navigation { display:flex;align-items:center;gap:12px;min-height:30px;padding:4px 12px;color:var(--muted); }
.browser-navigation svg { flex:none; }
.browser-address { display:flex;align-items:center;gap:8px;min-width:0;width:min(100%,380px);height:21px;padding:4px 9px;border:1px solid var(--line-strong);border-radius:6px;background:var(--surface-2); }
.address-mark { display:block;width:9px;height:9px;flex:none;border:1.5px solid var(--muted);border-radius:3px; }
.address-line { display:block;width:50%;max-width:110px;height:3px;border-radius:3px;background:var(--line-strong); }
@media(max-width:620px) { .browser-tab { min-width:68px; } }
</style>
