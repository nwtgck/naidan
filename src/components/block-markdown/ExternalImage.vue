<script setup lang="ts">
import { ref, computed } from 'vue';
import { Image as ImageIcon, Eye, Globe } from 'lucide-vue-next';
import { useExternalResourceSettings } from '@/composables/useExternalResourceSettings';

const props = defineProps<{
  src: string;
  alt: string | undefined;
  title: string | undefined;
}>();

const { allowAllExternalImages, setAllowAllExternalImages } = useExternalResourceSettings();
const showThisImage = ref(false);

const isExternal = computed(() => {
  try {
    // Relative URLs or data URLs are not "external" in the sense of leaking IP to 3rd party
    if (props.src.startsWith('data:') || props.src.startsWith('blob:') || props.src.startsWith('./') || props.src.startsWith('/') || !props.src.includes('://')) {
      return false;
    }
    const url = new URL(props.src);
    return url.origin !== window.location.origin;
  } catch (e) {
    // Fail safe: if URL is invalid or parsing fails, treat as external/untrusted
    return true;
  }
});

const shouldShow = computed(() => !isExternal.value || allowAllExternalImages.value || showThisImage.value);

function load() {
  showThisImage.value = true;
}

function loadAll() {
  setAllowAllExternalImages(true);
}

defineExpose({
  __testOnly: {
    showThisImage,
    isExternal,
    shouldShow,
  }
});
</script>

<template>
  <span v-if="!shouldShow" class="naidan-external-image-placeholder inline-flex items-center gap-1 px-1 py-0.5 my-1 bg-gray-100 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded text-xs text-gray-600 dark:text-gray-400 align-middle select-none">
    <span class="flex items-center gap-1.5 px-2 py-0.5 hover:bg-gray-200 dark:hover:bg-gray-700 cursor-pointer rounded transition-colors" @click="load" :title="src">
      <ImageIcon class="w-3.5 h-3.5" />
      <span class="max-w-[150px] truncate font-medium">{{ alt || 'External Image' }}</span>
      <Eye class="w-3.5 h-3.5 opacity-70" />
    </span>
    <span class="w-[1px] h-3 bg-gray-300 dark:bg-gray-600 mx-0.5"></span>
    <button class="p-1 hover:bg-gray-200 dark:hover:bg-gray-700 rounded transition-colors" @click="loadAll" title="Allow all external images in this session">
      <Globe class="w-3.5 h-3.5" />
    </button>
  </span>
  <img
    v-else
    :src="src"
    :alt="alt"
    :title="title"
    class="max-w-full h-auto rounded-lg shadow-sm my-2 inline-block align-middle"
  />
</template>
