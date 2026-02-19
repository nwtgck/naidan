<script setup lang="ts">
import { ref, computed, onUnmounted, watch, nextTick } from 'vue';
import {
  X, Info, ExternalLink, Copy, Check,
  Image as ImageIcon, Hash, Zap, Cpu,
  SortAsc, SortDesc
} from 'lucide-vue-next';
import type { MessageNode, BinaryObject } from '../models/types';
import { storageService } from '../services/storage';
import { useBinaryActions } from '../composables/useBinaryActions';
import { useImagePreview } from '../composables/useImagePreview';
import { useGlobalEvents } from '../composables/useGlobalEvents';
import { IMAGE_BLOCK_LANG, GeneratedImageBlockSchema, stripNaidanSentinels } from '../utils/image-generation';
import { ImageDownloadHydrator } from './ImageDownloadHydrator';
import ImageDownloadButton from './ImageDownloadButton.vue';

const props = defineProps<{
  chatId: string;
  messages: MessageNode[];
}>();

const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'jump-to-message', messageId: string): void;
}>();

const { downloadBinaryObject } = useBinaryActions();
const { openPreview } = useImagePreview();
const { addErrorEvent } = useGlobalEvents();

type MediaOrder = 'forward' | 'reverse';
const mediaOrder = ref<MediaOrder>('forward');

interface MediaItem {
  id: string;
  messageId: string;
  binaryObjectId: string;
  mimeType: string;
  size: number;
  name?: string;
  prompt?: string;
  steps?: number;
  seed?: number;
  model?: string;
  index: number;
  total: number;
}

interface MediaGroup {
  messageId: string;
  prompt?: string;
  items: MediaItem[];
  timestamp: number;
}

const mediaGroups = computed(() => {
  const groups: MediaGroup[] = [];

  props.messages.forEach(msg => {
    let items: MediaItem[] = [];
    let sharedPrompt: string | undefined;

    // 1. Attachments
    if (msg.attachments) {
      msg.attachments.forEach(att => {
        if (att.mimeType.startsWith('image/') && att.status !== 'missing') {
          items.push({
            id: att.id,
            messageId: msg.id,
            binaryObjectId: att.binaryObjectId,
            mimeType: att.mimeType,
            size: att.size,
            name: att.originalName,
            index: 0,
            total: 0
          });
        }
      });
    }

    // 2. Generated Images in content
    const codeBlockRegex = new RegExp('```' + IMAGE_BLOCK_LANG + '[^\\n]*\\n([\\s\\S]*?)\\n```', 'g');
    let match;
    while ((match = codeBlockRegex.exec(msg.content)) !== null) {
      try {
        const result = GeneratedImageBlockSchema.safeParse(JSON.parse(match[1] || '{}'));
        if (result.success) {
          const data = result.data;
          if (!sharedPrompt) sharedPrompt = data.prompt;
          items.push({
            id: data.binaryObjectId,
            messageId: msg.id,
            binaryObjectId: data.binaryObjectId,
            mimeType: 'image/png',
            size: 0,
            prompt: data.prompt,
            steps: data.steps,
            seed: data.seed,
            model: msg.modelId,
            index: 0,
            total: 0
          });
        }
      } catch (e) { /* ignore parse errors */ }
    }

    if (items.length > 0) {
      if (!sharedPrompt) {
        sharedPrompt = stripNaidanSentinels(msg.content).trim().slice(0, 100);
      }

      items.forEach((item, idx) => {
        item.index = idx + 1;
        item.total = items.length;
      });

      items = (() => {
        switch (mediaOrder.value) {
        case 'forward': return items;
        case 'reverse': return [...items].reverse();
        default: {
          const _ex: never = mediaOrder.value;
          return _ex;
        }
        }
      })();

      groups.push({
        messageId: msg.id,
        prompt: sharedPrompt || undefined,
        items,
        timestamp: msg.timestamp
      });
    }
  });

  return groups.sort((a, b) => b.timestamp - a.timestamp);
});

const allMediaItems = computed(() => {
  return mediaGroups.value.flatMap(g => g.items);
});

const thumbnails = ref<Record<string, string>>({});
const isSupportedMap = ref<Record<string, boolean>>({});
const thumbnailObserver = ref<IntersectionObserver | null>(null);

const loadMediaDetails = async (item: MediaItem) => {
  if (thumbnails.value[item.binaryObjectId]) return;

  try {
    const blob = await storageService.getFile(item.binaryObjectId);
    if (blob) {
      thumbnails.value[item.binaryObjectId] = URL.createObjectURL(blob);
      const support = await ImageDownloadHydrator.detectSupport(blob);
      isSupportedMap.value[item.binaryObjectId] = support;
    }
  } catch (e) {
    console.error('Failed to load shelf media details:', e);
  }
};

const setupObserver = () => {
  thumbnailObserver.value = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        const id = (entry.target as HTMLElement).dataset.id;
        if (id) {
          const item = allMediaItems.value.find(i => i.binaryObjectId === id);
          if (item) loadMediaDetails(item);
        }
      }
    });
  }, {
    root: scrollContainer.value,
    rootMargin: '600px 200px'
  });
};

const scrollContainer = ref<HTMLElement | null>(null);

watch(mediaGroups, async () => {
  await nextTick();
  if (!thumbnailObserver.value) setupObserver();

  const els = scrollContainer.value?.querySelectorAll('.media-item-trigger');
  els?.forEach(el => thumbnailObserver.value?.observe(el));
}, { immediate: true });

onUnmounted(() => {
  thumbnailObserver.value?.disconnect();
  Object.values(thumbnails.value).forEach(url => URL.revokeObjectURL(url));
});

const handlePreview = (item: MediaItem) => {
  const objects: BinaryObject[] = allMediaItems.value.map(i => ({
    id: i.binaryObjectId,
    mimeType: i.mimeType,
    size: i.size,
    createdAt: 0,
    name: i.name || i.prompt || 'Generated Image'
  }));

  openPreview({
    objects,
    initialId: item.binaryObjectId
  });
};

const handleDownload = async (item: MediaItem, { withMetadata }: { withMetadata: boolean }) => {
  if (withMetadata) {
    await ImageDownloadHydrator.download({
      id: item.binaryObjectId,
      prompt: item.prompt || '',
      steps: item.steps,
      seed: item.seed,
      model: item.model,
      withMetadata: true,
      storageService,
      onError: (err) => addErrorEvent({
        source: 'MediaShelf:Download',
        message: 'Failed to embed metadata in image.',
        details: err instanceof Error ? err.message : String(err),
      })
    });
  } else {
    const obj: BinaryObject = {
      id: item.binaryObjectId,
      mimeType: item.mimeType,
      size: item.size,
      createdAt: 0,
      name: item.name || (item.prompt ? item.prompt.slice(0, 30) : 'generated-image')
    };
    await downloadBinaryObject(obj);
  }
};

const copiedPromptId = ref<string | null>(null);
const copyPrompt = async (prompt: string, messageId: string) => {
  try {
    await navigator.clipboard.writeText(prompt);
    copiedPromptId.value = messageId;
    setTimeout(() => {
      if (copiedPromptId.value === messageId) copiedPromptId.value = null;
    }, 2000);
  } catch (e) {
    console.error('Failed to copy prompt:', e);
  }
};

const showingInfoId = ref<string | null>(null);
const copiedField = ref<string | null>(null);

const copyField = async (text: string | number | undefined, field: string) => {
  if (text === undefined) return;
  try {
    await navigator.clipboard.writeText(String(text));
    copiedField.value = `${showingInfoId.value}-${field}`;
    setTimeout(() => {
      if (copiedField.value === `${showingInfoId.value}-${field}`) copiedField.value = null;
    }, 1500);
  } catch (e) {
    console.error(`Failed to copy ${field}:`, e);
  }
};

defineExpose({
  __testOnly: {
    // Export internal state and logic used only for testing here. Do not reference these in production logic.
  }
});
</script>

<template>
  <div class="bg-white/95 dark:bg-gray-900/95 backdrop-blur-md border-t border-gray-100 dark:border-gray-800 shadow-2xl z-30 flex flex-col h-[70vh] min-h-[400px] overflow-hidden animate-in slide-in-from-bottom-full duration-300">
    <!-- Header -->
    <div class="px-4 py-2 border-b border-gray-100 dark:border-gray-800 flex items-center justify-between shrink-0">
      <div class="flex items-center gap-2">
        <div class="p-1 bg-blue-50 dark:bg-blue-900/20 rounded-lg">
          <ImageIcon class="w-4 h-4 text-blue-500" />
        </div>
        <span class="text-xs font-bold text-gray-700 dark:text-gray-200 uppercase tracking-widest">Media Shelf</span>
        <span class="text-[10px] font-bold px-1.5 py-0.5 bg-gray-100 dark:bg-gray-800 text-gray-500 rounded-full">
          {{ allMediaItems.length }}
        </span>
        <div class="w-px h-3 bg-gray-200 dark:bg-gray-700 mx-1"></div>
        <button
          @click="mediaOrder = mediaOrder === 'forward' ? 'reverse' : 'forward'"
          class="flex items-center gap-1.5 px-2 py-0.5 rounded-lg text-[10px] font-bold transition-all"
          :class="mediaOrder === 'reverse'
            ? 'bg-blue-50 dark:bg-blue-900/30 text-blue-600'
            : 'text-gray-400 hover:text-gray-600 dark:hover:text-gray-200'
          "
          :title="mediaOrder === 'forward' ? 'Currently Forward (1/N first)' : 'Currently Reverse (N/N first)'"
        >
          <SortDesc v-if="mediaOrder === 'forward'" class="w-3 h-3" />
          <SortAsc v-else class="w-3 h-3" />
          <span class="uppercase tracking-wider">{{ mediaOrder }}</span>
        </button>
      </div>
      <button
        @click="emit('close')"
        class="p-1 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800 text-gray-400 hover:text-red-500 transition-colors"
        title="Close Shelf"
      >
        <X class="w-4 h-4" />
      </button>
    </div>

    <!-- Media List (Vertical Scroll) -->
    <!-- Reduced space-y from 8 to 4 to tighten row spacing -->
    <div
      ref="scrollContainer"
      class="flex-1 overflow-y-auto px-4 py-2 space-y-4"
    >
      <div v-if="mediaGroups.length === 0" class="h-full flex flex-col items-center justify-center text-gray-400 dark:text-gray-500 gap-2">
        <ImageIcon class="w-12 h-12 opacity-10" />
        <span class="text-sm italic">No images in this chat yet</span>
      </div>
      <template v-else>
        <div
          v-for="group in mediaGroups"
          :key="group.messageId"
          class="flex flex-col gap-3 group/group relative hover:z-30"
        >
          <!-- Message Header: Jump Button & Shared Prompt -->
          <div class="flex items-start justify-between gap-4">
            <div class="flex-1 min-w-0">
              <div class="flex items-center gap-2 mb-1">
                <button
                  @click="emit('jump-to-message', group.messageId)"
                  class="flex items-center gap-1 px-1.5 py-0.5 rounded bg-gray-100 dark:bg-gray-800 text-[9px] font-bold text-gray-500 hover:text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-900/30 transition-all uppercase tracking-widest shrink-0"
                  title="Jump to this message in chat"
                >
                  <ExternalLink class="w-2.5 h-2.5" />
                  <span>Jump</span>
                </button>

                <div
                  v-if="group.prompt"
                  class="group/prompt relative flex-1 min-w-0 cursor-pointer"
                  @click="copyPrompt(group.prompt, group.messageId)"
                  title="Click to copy prompt"
                >
                  <div class="text-[10px] font-bold text-gray-400 dark:text-gray-500 truncate italic hover:text-blue-500 transition-colors pr-8">
                    {{ group.prompt }}
                  </div>
                  <div class="absolute right-0 top-1/2 -translate-y-1/2 opacity-0 group-hover/prompt:opacity-100 transition-opacity flex items-center gap-1 bg-white/80 dark:bg-gray-900/80 px-1 rounded shadow-sm">
                    <template v-if="copiedPromptId === group.messageId">
                      <Check class="w-2.5 h-2.5 text-green-500" />
                      <span class="text-[8px] font-bold text-green-500 uppercase">Copied!</span>
                    </template>
                    <template v-else>
                      <Copy class="w-2.5 h-2.5 text-blue-500" />
                    </template>
                  </div>
                </div>
                <div v-else class="text-[10px] font-bold text-gray-300 dark:text-gray-700 uppercase tracking-widest italic">
                  Manual Attachment
                </div>
              </div>
            </div>
          </div>

          <!-- Grouped Images (Horizontal Scroll) -->
          <!-- Use pb-24 to provide internal space for dropdowns, but -mb-20 to pull the next group up visually -->
          <div class="flex items-center gap-4 overflow-x-auto no-scrollbar pb-24 -mb-20 -mx-1 px-1">
            <div
              v-for="item in group.items"
              :key="item.id"
              :data-id="item.binaryObjectId"
              class="media-item-trigger relative w-36 h-36 shrink-0 group/item hover:z-40"
              @click="handlePreview(item)"
            >
              <div class="absolute inset-0 rounded-2xl border border-gray-100 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 shadow-sm hover:shadow-md hover:border-blue-500/50 transition-all overflow-hidden">
                <img
                  v-if="thumbnails[item.binaryObjectId]"
                  :src="thumbnails[item.binaryObjectId]"
                  class="w-full h-full object-cover transition-transform group-hover/item:scale-110"
                />
                <div v-else class="w-full h-full flex items-center justify-center">
                  <ImageIcon class="w-8 h-8 text-gray-300 animate-pulse" />
                </div>

                <!-- Hover Gradient -->
                <div class="absolute inset-0 bg-gradient-to-t from-black/20 via-transparent to-transparent opacity-0 group-hover/item:opacity-100 transition-opacity pointer-events-none"></div>
              </div>

              <!-- Item Overlay - Top Buttons -->
              <div class="absolute top-2 right-2 z-30 flex flex-col gap-1.5 opacity-0 group-hover/item:opacity-100 transition-all scale-90 origin-top-right">
                <div @click.stop>
                  <ImageDownloadButton
                    :is-supported="isSupportedMap[item.binaryObjectId]"
                    :on-download="(options) => handleDownload(item, options)"
                  />
                </div>
                <button
                  v-if="item.prompt || item.seed || item.steps"
                  class="p-2 bg-white/90 dark:bg-gray-800/90 backdrop-blur-sm border border-gray-100 dark:border-gray-700 rounded-lg text-gray-500 hover:text-blue-600 shadow-sm transition-colors flex items-center justify-center"
                  title="View details & Copy parameters"
                  @click.stop="showingInfoId = item.id"
                >
                  <Info class="w-4 h-4" />
                </button>
              </div>

              <!-- Info Details Overlay (Copyable) -->
              <div
                v-if="showingInfoId === item.id"
                class="absolute inset-0 z-50 bg-white/95 dark:bg-gray-900/95 p-3 rounded-2xl border border-blue-200 dark:border-blue-800 flex flex-col gap-2 animate-in fade-in zoom-in duration-200 shadow-xl"
                @click.stop
              >
                <div class="flex items-center justify-between border-b dark:border-gray-800 pb-1.5 mb-1">
                  <span class="text-[10px] font-bold text-gray-400 uppercase tracking-widest">Parameters</span>
                  <button @click="showingInfoId = null" class="p-1 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg text-gray-400 hover:text-red-500 transition-colors">
                    <X class="w-3.5 h-3.5" />
                  </button>
                </div>

                <div class="space-y-1.5 flex-1 overflow-y-auto pr-1 no-scrollbar">
                  <!-- Steps -->
                  <div class="flex items-center justify-between group/field">
                    <div class="flex items-center gap-1.5 text-[9px] font-bold text-gray-500">
                      <Zap class="w-2.5 h-2.5" />
                      <span>Steps</span>
                    </div>
                    <button
                      @click="copyField(item.steps, 'steps')"
                      class="flex items-center gap-1.5 px-1.5 py-0.5 rounded hover:bg-blue-50 dark:hover:bg-blue-900/30 text-[10px] font-mono text-gray-700 dark:text-gray-300 transition-all"
                    >
                      <span>{{ item.steps ?? 'N/A' }}</span>
                      <template v-if="copiedField === `${item.id}-steps`">
                        <Check class="w-2.5 h-2.5 text-green-500" />
                      </template>
                      <Copy v-else class="w-2.5 h-2.5 opacity-0 group-hover/field:opacity-100 text-blue-500" />
                    </button>
                  </div>

                  <!-- Seed -->
                  <div class="flex items-center justify-between group/field">
                    <div class="flex items-center gap-1.5 text-[9px] font-bold text-gray-500">
                      <Hash class="w-2.5 h-2.5" />
                      <span>Seed</span>
                    </div>
                    <button
                      @click="copyField(item.seed, 'seed')"
                      class="flex items-center gap-1.5 px-1.5 py-0.5 rounded hover:bg-blue-50 dark:hover:bg-blue-900/30 text-[10px] font-mono text-gray-700 dark:text-gray-300 transition-all"
                    >
                      <span class="truncate max-w-[60px]">{{ item.seed ?? 'N/A' }}</span>
                      <template v-if="copiedField === `${item.id}-seed`">
                        <Check class="w-2.5 h-2.5 text-green-500" />
                      </template>
                      <Copy v-else class="w-2.5 h-2.5 opacity-0 group-hover/field:opacity-100 text-blue-500" />
                    </button>
                  </div>

                  <!-- Model -->
                  <div class="flex flex-col gap-1 group/field">
                    <div class="flex items-center gap-1.5 text-[9px] font-bold text-gray-500">
                      <Cpu class="w-2.5 h-2.5" />
                      <span>Model</span>
                    </div>
                    <button
                      @click="copyField(item.model, 'model')"
                      class="flex items-center justify-between w-full px-1.5 py-0.5 rounded hover:bg-blue-50 dark:hover:bg-blue-900/30 text-[9px] font-mono text-gray-700 dark:text-gray-300 transition-all text-left"
                    >
                      <span class="truncate">{{ item.model ?? 'N/A' }}</span>
                      <template v-if="copiedField === `${item.id}-model`">
                        <Check class="w-2.5 h-2.5 text-green-500 shrink-0" />
                      </template>
                      <Copy v-else class="w-2.5 h-2.5 opacity-0 group-hover/field:opacity-100 text-blue-500 shrink-0" />
                    </button>
                  </div>
                </div>
              </div>

              <!-- Bottom Overlay: Index Badge -->
              <div class="absolute bottom-2 left-2 z-20">
                <div class="px-1.5 py-0.5 bg-black/50 backdrop-blur-md rounded text-[9px] font-bold text-white shadow-sm border border-white/10">
                  {{ item.index }} / {{ item.total }}
                </div>
              </div>
            </div>
          </div>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.no-scrollbar::-webkit-scrollbar {
  display: none;
}
.no-scrollbar {
  -ms-overflow-style: none;
  scrollbar-width: none;
}
</style>
