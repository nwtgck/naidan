<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, useId, watch, type Ref } from 'vue';
import { ChevronDownIcon, DownloadIcon, LoaderCircleIcon, Settings2Icon } from 'lucide-vue-next';
import { lazyStrings } from '@/strings';
import type { ImageDownloadFormat, ImageDownloadPreferences, ImageDownloadResult } from '@/features/stable-diffusion-cpp-browser/use-image-generation-types';
const props = defineProps<{
  active: boolean, disabled: boolean,
  preferences: Ref<ImageDownloadPreferences>,
  onPreferencesChange: ({ preferences }: { preferences: ImageDownloadPreferences }) => void,
  onDownload: ({ format, includeMetadata }: { format: ImageDownloadFormat, includeMetadata: boolean }) => Promise<ImageDownloadResult>,
}>();
const id = useId();
const anchor = ref<HTMLElement>(), panel = ref<HTMLElement>(), toggle = ref<HTMLButtonElement>();
const open = ref(false), busy = ref(false), error = ref('');
const format = ref<ImageDownloadFormat>(props.preferences.value.format);
const includeMetadata = ref(props.preferences.value.metadata === 'include');
watch(() => [props.preferences.value.format, props.preferences.value.metadata] as const, ([nextFormat, nextMetadata]) => {
  format.value = nextFormat;
  includeMetadata.value = nextMetadata === 'include';
});
function changeFormat({ event }: { event: Event }): void {
  if (!(event.target instanceof HTMLSelectElement)) return;
  const value = event.target.value;
  if (value !== 'png' && value !== 'webp' && value !== 'jpeg') return;
  format.value = value;
  props.onPreferencesChange({ preferences: { format: value, metadata: includeMetadata.value ? 'include' : 'omit' } });
}
function changeMetadata({ event }: { event: Event }): void {
  if (!(event.target instanceof HTMLInputElement)) return;
  includeMetadata.value = event.target.checked;
  props.onPreferencesChange({ preferences: { format: format.value, metadata: includeMetadata.value ? 'include' : 'omit' } });
}
const position = ref({ left: '8px', top: '8px' });
let disposed = false;
function close({ restoreFocus }: { restoreFocus: boolean }): void {
  open.value = false;
  if (restoreFocus && props.active) toggle.value?.focus();
}
async function show(): Promise<void> {
  if (disposed || !props.active || props.disabled) return;
  const rect = anchor.value?.getBoundingClientRect();
  position.value = { left: `${Math.max(8, Math.min(rect?.left ?? 8, window.innerWidth - 304))}px`, top: `${Math.max(8, Math.min(rect?.bottom ?? 8, window.innerHeight - 320))}px` };
  open.value = true;
  await nextTick();
  if (open.value) panel.value?.focus();
}
async function download(): Promise<void> {
  if (busy.value || props.disabled) return;
  busy.value = true;
  error.value = '';
  try {
    const result = await props.onDownload({ format: format.value, includeMetadata: includeMetadata.value });
    if (disposed) return;
    switch (result.status) {
    case 'downloaded': close({ restoreFocus: open.value }); break;
    case 'cancelled': break;
    case 'failed': error.value = result.message; await show(); break;
    default: { const exhaustive: never = result; throw new Error(String(exhaustive)); }
    }
  } catch (cause) {
    if (!disposed) {
      error.value = cause instanceof Error ? cause.message : String(cause);
      await show();
    }
  } finally {
    busy.value = false;
  }
}
function outside({ event }: { event: Event }): void {
  if (event.target instanceof Node && !anchor.value?.contains(event.target) && !panel.value?.contains(event.target)) close({ restoreFocus: false });
}
function keydown({ event }: { event: KeyboardEvent }): void {
  if (event.key === 'Escape') {
    event.preventDefault();
    close({ restoreFocus: true });
  }
  if (event.key !== 'Tab') return;
  const controls = Array.from(panel.value?.querySelectorAll<HTMLElement>('*') ?? []).filter(control => control.matches('button, select, input') && !control.matches(':disabled'));
  const first = controls[0], last = controls.at(-1);
  if (event.shiftKey && (document.activeElement === first || document.activeElement === panel.value)) {
    event.preventDefault(); last?.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault(); first?.focus();
  }
}
const viewportChanged: EventListener = event => {
  if (event.target instanceof Node && panel.value?.contains(event.target)) return;
  close({ restoreFocus: false });
};
const onPointer: EventListener = event => {
  outside({ event });
};
watch(() => props.active && !props.disabled, available => {
  if (!available) close({ restoreFocus: false });
});
onMounted(() => {
  document.addEventListener('pointerdown', onPointer);
  window.addEventListener('resize', viewportChanged);
  document.addEventListener('scroll', viewportChanged, true);
});
onBeforeUnmount(() => {
  disposed = true;
  document.removeEventListener('pointerdown', onPointer);
  window.removeEventListener('resize', viewportChanged);
  document.removeEventListener('scroll', viewportChanged, true);
});
defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>
<template>
  <div ref="anchor" tw-class="inline-flex rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-blue-600 dark:text-blue-400 shadow-sm" data-testid="image-download-menu">
    <button type="button" :disabled="disabled || busy" @click="download" data-testid="image-download-default" tw-class="min-h-10 flex items-center gap-2 rounded-l-xl px-3 py-2 text-xs font-bold transition-colors hover:bg-blue-50 dark:hover:bg-blue-900/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-40 disabled:cursor-not-allowed">
      <LoaderCircleIcon v-if="busy" aria-hidden="true" tw-class="w-4 h-4 animate-spin" /><DownloadIcon v-else aria-hidden="true" tw-class="w-4 h-4" />{{ lazyStrings.ImageDownloadMenu__download() }} {{ format === 'webp' ? 'WebP' : format.toUpperCase() }}<Settings2Icon v-if="includeMetadata" role="img" aria-hidden="false" :aria-label="lazyStrings.ImageDownloadMenu__include_generation_settings()" :title="lazyStrings.ImageDownloadMenu__include_generation_settings()" tw-class="w-4 h-4" />
    </button>
    <button ref="toggle" type="button" :disabled="disabled || busy" :aria-expanded="open" :aria-controls="id" aria-haspopup="dialog" :aria-label="lazyStrings.ImageDownloadMenu__download_options()" @click="open ? close({ restoreFocus: false }) : show()" data-testid="image-download-options" tw-class="min-h-10 min-w-10 flex items-center justify-center border-l border-gray-200 dark:border-gray-700 rounded-r-xl transition-colors hover:bg-blue-50 dark:hover:bg-blue-900/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-40 disabled:cursor-not-allowed"><ChevronDownIcon aria-hidden="true" tw-class="w-4 h-4" /></button>
    <Teleport to="body">
      <div v-if="open" :id="id" ref="panel" tabindex="-1" role="dialog" :aria-label="lazyStrings.ImageDownloadMenu__download_options()" :style="position" @keydown.stop="keydown({ event: $event })" data-testid="image-download-panel" tw-class="fixed z-[140] w-72 max-w-[calc(100vw-1rem)] max-h-[calc(100vh-1rem)] overflow-y-auto rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 shadow-xl p-4 space-y-3 outline-none">
        <label tw-class="block text-sm font-medium space-y-1"><span>{{ lazyStrings.ImageDownloadMenu__image_format() }}</span><span tw-class="relative block"><select :value="format" :disabled="busy" @change="changeFormat({ event: $event })" data-testid="image-download-format" tw-class="appearance-none cursor-pointer pr-9 w-full rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-2 text-gray-800 dark:text-gray-100 shadow-sm outline-none focus:border-blue-400 focus:ring-4 focus:ring-blue-500/10 disabled:opacity-50"><option value="png">PNG</option><option value="webp">WebP</option><option value="jpeg">JPEG</option></select><ChevronDownIcon aria-hidden="true" tw-class="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" /></span></label>
        <label tw-class="min-h-10 cursor-pointer flex items-start gap-2 text-sm"><input :checked="includeMetadata" :disabled="busy" @change="changeMetadata({ event: $event })" type="checkbox" role="switch" data-testid="image-download-metadata" tw-class="sr-only peer" /><span aria-hidden="true" tw-class="relative h-6 w-10 shrink-0 rounded-full bg-gray-200 dark:bg-gray-700 transition-colors peer-checked:bg-blue-600 peer-focus-visible:outline-none peer-focus-visible:ring-2 peer-focus-visible:ring-blue-500 peer-focus-visible:ring-offset-2 dark:peer-focus-visible:ring-offset-gray-900 peer-disabled:opacity-40 peer-disabled:cursor-not-allowed after:content-[''] after:absolute after:top-1 after:left-1 after:h-4 after:w-4 after:rounded-full after:bg-white after:shadow-sm after:transition-transform peer-checked:after:translate-x-4 motion-reduce:transition-none motion-reduce:after:transition-none" />{{ lazyStrings.ImageDownloadMenu__include_generation_settings() }}</label>
        <p tw-class="text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.ImageDownloadMenu__downloaded_copy_only() }}</p>
        <p v-if="error" role="alert" data-testid="image-download-error" tw-class="text-sm text-red-600 dark:text-red-400 break-words">{{ error }}</p>
        <button type="button" :disabled="busy" @click="download" data-testid="image-download-confirm" tw-class="w-full min-h-10 rounded-xl bg-blue-600 text-white px-3 py-2 text-sm font-bold shadow-lg shadow-blue-500/25 transition-all hover:bg-blue-700 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-blue-500/30 disabled:opacity-40 disabled:cursor-not-allowed disabled:shadow-none"><LoaderCircleIcon v-if="busy" aria-hidden="true" tw-class="inline w-4 h-4 mr-2 animate-spin" />{{ lazyStrings.ImageDownloadMenu__download() }}</button>
      </div>
    </Teleport>
  </div>
</template>
