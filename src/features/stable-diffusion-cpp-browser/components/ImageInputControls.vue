<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue';
import { ArrowLeftIcon, ArrowRightIcon, ImagePlusIcon, ImageOffIcon, ReplaceIcon, Trash2Icon, ZoomInIcon } from 'lucide-vue-next';
import { lazyStrings } from '@/strings';
import type { ImageInputs } from '@/features/stable-diffusion-cpp-browser/types';
import ImageSettingsSection from './ImageSettingsSection.vue';
import ImageGenerationViewer from './ImageGenerationViewer.vue';
const props = defineProps<{ modelValue: ImageInputs, disabled: boolean, active: boolean }>();
const emit = defineEmits<{ 'update:modelValue': [value: ImageInputs] }>();
type Role = 'initial' | 'reference';
type Preview = { key: number, file: File, url: string | undefined, failed: boolean };
const open = ref(false), invalid = ref<Role>(), dragging = ref<Role>(), viewerIndex = ref<number>();
const previews = shallowRef(new Map<File, Preview>());
let nextKey = 0;
const orderedFiles = computed(() => [...(props.modelValue.initImage ? [props.modelValue.initImage] : []), ...props.modelValue.referenceImages]);
const frames = computed(() => orderedFiles.value.flatMap(file => {
  const preview = previews.value.get(file); return preview ? [preview] : [];
}));
const groups = computed(() => [
  { role: 'initial' as const, title: lazyStrings.ImageInputControls__initial_image(), help: lazyStrings.ImageInputControls__initial_image_help(), frames: props.modelValue.initImage ? frames.value.slice(0, 1) : [] },
  { role: 'reference' as const, title: lazyStrings.ImageInputControls__reference_images(), help: lazyStrings.ImageInputControls__reference_images_help(), frames: frames.value.slice(props.modelValue.initImage ? 1 : 0) },
]);
watch(orderedFiles, (files, previous) => {
  if (!previous || files.length !== previous.length || files.some((file, index) => file !== previous[index])) viewerIndex.value = undefined;
  const retained = new Set(files), next = new Map<File, Preview>();
  for (const file of retained) {
    const existing = previews.value.get(file);
    if (existing) next.set(file, existing);
    else {
      // Blob URLs avoid reading/re-encoding image bytes merely to render the UI.
      try {
        next.set(file, { key: ++nextKey, file, url: URL.createObjectURL(file), failed: false });
      } catch {
        next.set(file, { key: ++nextKey, file, url: undefined, failed: true });
      }
    }
  }
  for (const [file, preview] of previews.value) if (!retained.has(file) && preview.url) URL.revokeObjectURL(preview.url);
  previews.value = next;
}, { immediate: true });
watch(() => props.active, active => {
  if (!active) viewerIndex.value = undefined;
});
onBeforeUnmount(() => {
  for (const preview of previews.value.values()) if (preview.url) URL.revokeObjectURL(preview.url);
  previews.value.clear();
});
function failed({ preview }: { preview: Preview }): void {
  // Ignore late decode events from thumbnails replaced or removed meanwhile.
  if (previews.value.get(preview.file)?.url !== preview.url) return;
  const next = new Map(previews.value);
  next.set(preview.file, { ...preview, failed: true }); previews.value = next;
}
function accept({ role, files, replaceIndex }: { role: Role, files: File[], replaceIndex: number | undefined }): void {
  if (props.disabled || !files.length) return;
  if (files.some(file => file.size === 0 || !['image/png', 'image/jpeg', 'image/webp'].includes(file.type))) {
    invalid.value = role; return;
  }
  invalid.value = undefined;
  switch (role) {
  case 'initial': emit('update:modelValue', { ...props.modelValue, initImage: files[0] }); break;
  case 'reference': {
    const references = [...props.modelValue.referenceImages];
    if (replaceIndex === undefined) references.push(...files);
    else {
      if (replaceIndex < 0 || replaceIndex >= references.length) return;
      const file = files[0]; if (!file) return;
      references[replaceIndex] = file;
    }
    emit('update:modelValue', { ...props.modelValue, referenceImages: references }); break;
  }
  default: { const exhaustive: never = role; throw new Error(String(exhaustive)); }
  }
}
function choose({ role, event, replaceIndex }: { role: Role, event: Event, replaceIndex: number | undefined }): void {
  if (!(event.target instanceof HTMLInputElement)) return;
  const files = Array.from(event.target.files ?? []); event.target.value = '';
  accept({ role, files, replaceIndex });
}
function drop({ role, event }: { role: Role, event: DragEvent }): void {
  dragging.value = undefined;
  accept({ role, files: Array.from(event.dataTransfer?.files ?? []), replaceIndex: undefined });
}
function dragLeave({ event }: { event: DragEvent }): void {
  if (event.currentTarget instanceof Node && event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
  dragging.value = undefined;
}
function strength({ event }: { event: Event }): void {
  if (props.disabled || !(event.target instanceof HTMLInputElement)) return;
  emit('update:modelValue', { ...props.modelValue, strength: event.target.valueAsNumber });
}
function remove({ role, index }: { role: Role, index: number }): void {
  if (props.disabled) return;
  invalid.value = undefined;
  switch (role) {
  case 'initial': emit('update:modelValue', { ...props.modelValue, initImage: undefined }); break;
  case 'reference': emit('update:modelValue', { ...props.modelValue, referenceImages: props.modelValue.referenceImages.filter((_file, position) => position !== index) }); break;
  default: { const exhaustive: never = role; throw new Error(String(exhaustive)); }
  }
}
function move({ index, offset }: { index: number, offset: number }): void {
  if (props.disabled) return;
  const references = [...props.modelValue.referenceImages], target = index + offset, file = references[index];
  if (!file || target < 0 || target >= references.length) return;
  references.splice(index, 1); references.splice(target, 0, file);
  emit('update:modelValue', { ...props.modelValue, referenceImages: references });
}
function enlarge({ role, index }: { role: Role, index: number }): void {
  if (props.active) viewerIndex.value = index + (role === 'reference' && props.modelValue.initImage ? 1 : 0);
}
defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>
<template>
  <ImageSettingsSection v-model:open="open" :title="lazyStrings.ImageInputControls__input_images()" :summary="undefined" data-testid="image-input-controls">
    <template #summary>
      <span v-if="frames.length" tw-class="inline-flex items-center gap-2">
        <span tw-class="inline-flex -space-x-2">
          <span v-for="(frame, index) in frames.slice(0, 3)" :key="frame.key + ':' + index" tw-class="block w-7 h-7 rounded-md border-2 border-white dark:border-gray-900 overflow-hidden bg-gray-100 dark:bg-gray-800">
            <img v-if="frame.url && !frame.failed" :src="frame.url" alt="" decoding="async" loading="lazy" @error="failed({ preview: frame })" tw-class="w-full h-full object-cover" />
            <ImageOffIcon v-else tw-class="w-4 h-4 m-1 text-gray-400" />
          </span>
        </span>
        {{ lazyStrings.ImageInputControls__image_count({ count: frames.length }) }}
      </span>
      <ImagePlusIcon v-else aria-hidden="true" tw-class="w-4 h-4" />
    </template>
    <p tw-class="text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.ImageInputControls__model_support_required() }}</p>
    <div v-for="group in groups" :key="group.role" @dragover.prevent="!disabled && (dragging = group.role)" @dragleave="dragLeave({ event: $event })" @drop.prevent.stop="drop({ role: group.role, event: $event })" :tw-class="['rounded-xl border p-3 space-y-3 transition-colors', dragging === group.role ? 'border-blue-400 bg-blue-50 dark:bg-blue-950/30' : 'border-gray-200 dark:border-gray-800']" :data-testid="'image-input-' + group.role + '-drop'">
      <div tw-class="space-y-1">
        <h3 tw-class="text-sm font-medium">{{ group.title }}</h3>
        <p tw-class="text-xs text-gray-500 dark:text-gray-400">{{ group.help }}</p>
      </div>
      <div v-if="group.frames.length" :tw-class="['grid gap-3', group.role === 'reference' ? 'grid-cols-2 sm:grid-cols-3' : 'grid-cols-1 max-w-48']">
        <article v-for="(frame, index) in group.frames" :key="frame.key + ':' + index" tw-class="min-w-0 rounded-lg border border-gray-200 dark:border-gray-800 overflow-hidden">
          <button type="button" @click="enlarge({ role: group.role, index })" :aria-label="lazyStrings.ImageInputControls__expand_image()" :data-testid="'image-input-expand-' + group.role" tw-class="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 relative block w-full aspect-square bg-gray-100 dark:bg-gray-800">
            <img v-if="open && frame.url && !frame.failed" :src="frame.url" :alt="frame.file.name" decoding="async" loading="lazy" @error="failed({ preview: frame })" tw-class="w-full h-full object-contain" />
            <ImageOffIcon v-if="frame.failed" tw-class="w-6 h-6 mx-auto text-gray-400" />
            <span v-if="group.role === 'reference'" tw-class="absolute top-1.5 left-1.5 rounded-md px-1.5 py-0.5 bg-black/60 text-white text-xs tabular-nums">{{ index + 1 }}</span>
            <ZoomInIcon aria-hidden="true" tw-class="absolute bottom-1.5 right-1.5 w-5 h-5 p-0.5 rounded bg-black/50 text-white" />
          </button>
          <div tw-class="p-2 space-y-2">
            <p tw-class="text-xs truncate" :title="frame.file.name">{{ frame.file.name }}</p>
            <p v-if="frame.failed" role="alert" tw-class="text-xs text-red-600 dark:text-red-400">{{ lazyStrings.ImageInputControls__preview_unavailable() }}</p>
            <div tw-class="flex flex-wrap items-center gap-1">
              <template v-if="group.role === 'reference'">
                <button type="button" :disabled="disabled || index === 0" @click="move({ index, offset: -1 })" :aria-label="lazyStrings.ImageInputControls__move_earlier()" :title="lazyStrings.ImageInputControls__move_earlier()" data-testid="image-input-reference-earlier" tw-class="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 inline-flex items-center justify-center rounded-xl min-h-10 min-w-10 p-2 text-gray-500 dark:text-gray-400 transition-colors hover:bg-gray-100 dark:hover:bg-gray-700 disabled:opacity-30 disabled:cursor-not-allowed"><ArrowLeftIcon tw-class="w-4 h-4" /></button>
                <button type="button" :disabled="disabled || index === group.frames.length - 1" @click="move({ index, offset: 1 })" :aria-label="lazyStrings.ImageInputControls__move_later()" :title="lazyStrings.ImageInputControls__move_later()" data-testid="image-input-reference-later" tw-class="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 inline-flex items-center justify-center rounded-xl min-h-10 min-w-10 p-2 text-gray-500 dark:text-gray-400 transition-colors hover:bg-gray-100 dark:hover:bg-gray-700 disabled:opacity-30 disabled:cursor-not-allowed"><ArrowRightIcon tw-class="w-4 h-4" /></button>
                <label :title="lazyStrings.ImageInputControls__replace_image()" :tw-class="['inline-flex items-center justify-center rounded-lg min-h-10 min-w-10 p-2 text-gray-500 dark:text-gray-400 focus-within:ring-2 focus-within:ring-blue-500', disabled ? 'opacity-30' : 'cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-800']"><ReplaceIcon tw-class="w-4 h-4" /><input type="file" accept="image/png,image/jpeg,image/webp" :aria-label="lazyStrings.ImageInputControls__replace_image()" :disabled="disabled" @change="choose({ role: 'reference', event: $event, replaceIndex: index })" data-testid="image-input-replace-reference" tw-class="sr-only" /></label>
              </template>
              <button type="button" :disabled="disabled" @click="remove({ role: group.role, index })" :aria-label="lazyStrings.ImageInputControls__remove()" :title="lazyStrings.ImageInputControls__remove()" :data-testid="group.role === 'initial' ? 'image-input-clear-initial' : 'image-input-remove-reference'" tw-class="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500 inline-flex items-center justify-center rounded-xl min-h-10 min-w-10 p-2 text-red-600 dark:text-red-400 transition-colors hover:bg-red-50 dark:hover:bg-red-900/20 disabled:opacity-30 disabled:cursor-not-allowed"><Trash2Icon tw-class="w-4 h-4" /></button>
            </div>
          </div>
        </article>
      </div>
      <p v-else tw-class="text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.ImageInputControls__drop_image_here() }}</p>
      <label :tw-class="['min-h-10 inline-flex items-center gap-2 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-xs font-bold text-blue-600 dark:text-blue-400 shadow-sm transition-colors focus-within:ring-2 focus-within:ring-blue-500', disabled ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer hover:border-blue-200 dark:hover:border-blue-900/50 hover:bg-blue-50 dark:hover:bg-blue-900/20']">
        <ReplaceIcon v-if="group.role === 'initial' && group.frames.length" tw-class="w-4 h-4" /><ImagePlusIcon v-else tw-class="w-4 h-4" />
        {{ group.role === 'reference' ? lazyStrings.ImageInputControls__add_reference_images() : group.frames.length ? lazyStrings.ImageInputControls__replace_image() : lazyStrings.ImageInputControls__choose_image() }}
        <input type="file" :multiple="group.role === 'reference'" accept="image/png,image/jpeg,image/webp" :disabled="disabled" @change="choose({ role: group.role, event: $event, replaceIndex: undefined })" :data-testid="group.role === 'initial' ? 'image-input-initial' : 'image-input-references'" tw-class="sr-only" />
      </label>
      <label v-if="group.role === 'initial' && group.frames.length" tw-class="block space-y-2">
        <span tw-class="text-xs font-medium">{{ lazyStrings.ImageInputControls__change_strength() }}</span>
        <span tw-class="flex items-center gap-3">
          <input type="range" min="0" max="1" step="0.05" :value="modelValue.strength" :disabled="disabled" @input="strength({ event: $event })" :aria-label="lazyStrings.ImageInputControls__change_strength()" data-testid="image-input-strength-slider" tw-class="min-w-0 flex-1 accent-blue-600 disabled:opacity-40" />
          <input type="number" min="0" max="1" step="0.05" required :value="modelValue.strength" :disabled="disabled" @input="strength({ event: $event })" data-testid="image-input-strength" tw-class="w-20 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-2.5 py-2 text-sm tabular-nums text-gray-800 dark:text-gray-100 shadow-sm outline-none focus:border-blue-400 focus:ring-4 focus:ring-blue-500/10 disabled:opacity-40" />
        </span>
      </label>
      <p v-if="invalid === group.role" role="alert" tw-class="text-xs text-red-600 dark:text-red-400">{{ lazyStrings.ImageInputControls__choose_png_jpeg_or_webp() }}</p>
    </div>
  </ImageSettingsSection>
  <ImageGenerationViewer v-if="active && viewerIndex !== undefined" v-model:index="viewerIndex" :count="frames.length" :download-enabled="false" @close="viewerIndex = undefined">
    <template #default="{ index }">
      <img v-if="frames[index]?.url && !frames[index]?.failed" :src="frames[index]?.url" :alt="frames[index]?.file.name" decoding="async" tw-class="max-w-[94vw] max-h-[82vh] object-contain" />
      <p v-else tw-class="p-6 text-sm">{{ lazyStrings.ImageInputControls__preview_unavailable() }}</p>
    </template>
  </ImageGenerationViewer>
</template>
