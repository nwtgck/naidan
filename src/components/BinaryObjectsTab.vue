<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed, watch } from 'vue';
import { storageService } from '../services/storage';
import type { BinaryObject } from '../models/types';
import { 
  File, Search, ArrowUp, ArrowDown, Download, 
  Eye, HardDrive, 
  Trash2, RefreshCw, LayoutGrid, List
} from 'lucide-vue-next';
import { Semaphore } from '../utils/concurrency';
import { defineAsyncComponentAndLoadOnMounted } from '../utils/vue';
// Lazily load the preview modal since it's only shown after user interaction, but prefetch it when idle.
const BinaryObjectPreviewModal = defineAsyncComponentAndLoadOnMounted(() => import('./BinaryObjectPreviewModal.vue'));
import { useImagePreview } from '../composables/useImagePreview';
import { useBinaryActions } from '../composables/useBinaryActions';

const objects = ref<BinaryObject[]>([]);
const isLoading = ref(true);
const searchQuery = ref('');
const sortBy = ref<'createdAt' | 'name' | 'size' | 'mimeType'>('createdAt');
const sortOrder = ref<'asc' | 'desc'>('desc');
const viewMode = ref<'table' | 'grid'>('table');

const { state: previewState, openPreview, closePreview } = useImagePreview();
const { deleteBinaryObject, downloadBinaryObject } = useBinaryActions();

// Incremental rendering
const displayLimit = ref(60); // Start with a bit more
const loadMoreSentinel = ref<HTMLElement | null>(null);
const isAddingItems = ref(false);

// Limit concurrent image processing to keep UI responsive
const thumbnailSemaphore = new Semaphore(2); // Reduced slightly for better scroll priority

const fetchObjects = async () => {
  isLoading.value = true;
  const newObjects: BinaryObject[] = [];
  try {
    const iterable = storageService.listBinaryObjects();
    for await (const obj of iterable) {
      newObjects.push(obj);
    }
    objects.value = newObjects;
    displayLimit.value = 60;
  } catch (error) {
    console.error('Failed to fetch binary objects:', error);
  } finally {
    isLoading.value = false;
  }
};

const loadMore = () => {
  if (isAddingItems.value) return;
  if (displayLimit.value < filteredObjects.value.length) {
    isAddingItems.value = true;
    displayLimit.value += 60; // Larger increments = fewer layout passes
    setTimeout(() => {
      isAddingItems.value = false;
    }, 200);
  }
};

const filteredObjects = computed(() => {
  let result = [...objects.value];

  if (searchQuery.value) {
    const q = searchQuery.value.toLowerCase();
    result = result.filter(f => 
      (f.name || 'unnamed').toLowerCase().includes(q) || 
      f.id.toLowerCase().includes(q) ||
      f.mimeType.toLowerCase().includes(q)
    );
  }

  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
  
  result.sort((a, b) => {
    let cmp = 0;
    switch (sortBy.value) {
    case 'createdAt':
      cmp = a.createdAt - b.createdAt;
      break;
    case 'size':
      cmp = a.size - b.size;
      break;
    case 'mimeType':
      cmp = collator.compare(a.mimeType, b.mimeType);
      break;
    case 'name':
    default:
      cmp = collator.compare(a.name || '', b.name || '');
      break;
    }
    const cmpResult = (() => {
      switch (sortOrder.value) {
      case 'asc': return cmp;
      case 'desc': return -cmp;
      default: {
        const _ex: never = sortOrder.value;
        console.error('Unhandled sort order:', _ex);
        return cmp;
      }      
      }
    })();
    return cmpResult;
  });

  return result;
});

const renderedObjects = computed(() => {
  return filteredObjects.value.slice(0, displayLimit.value);
});

// Fast O(1) lookup
const objectMap = computed(() => {
  const map = new Map<string, BinaryObject>();
  for (const obj of objects.value) {
    map.set(obj.id, obj);
  }
  return map;
});

// Reset display limit when filtering or sorting changes
watch([searchQuery, sortBy, sortOrder], () => {
  displayLimit.value = 60;
});

const handleSort = (key: typeof sortBy.value) => {
  if (sortBy.value === key) {
    sortOrder.value = (() => {
      switch (sortOrder.value) {
      case 'asc': return 'desc';
      case 'desc': return 'asc';
      default: {
        const _ex: never = sortOrder.value;
        return _ex;
      }
      }
    })();
  } else {
    sortBy.value = key;
    sortOrder.value = (() => {
      switch (key) {
      case 'createdAt':
      case 'size':
        return 'desc';
      case 'name':
      case 'mimeType':
        return 'asc';
      default: {
        const _ex: never = key;
        return _ex;
      }
      }
    })();
  }
};

const formatSize = (bytes: number) => {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
};

const formatDate = (timestamp: number) => {
  return new Date(timestamp).toLocaleString();
};

const handleDownload = async (obj: BinaryObject) => {
  await downloadBinaryObject(obj);
};

const handlePreview = (obj: BinaryObject) => {
  openPreview({ objects: filteredObjects.value, initialId: obj.id });
};

const handleDelete = async (obj: BinaryObject) => {
  const success = await deleteBinaryObject(obj.id);
  if (success) {
    objects.value = objects.value.filter(o => o.id !== obj.id);
  }
};

// Thumbnail Management
const thumbnails = ref<Record<string, string>>({}); // Values are Object URLs
const thumbnailLoading = ref<Set<string>>(new Set());
const visibleIds = new Set<string>(); // Not reactive for performance
const thumbnailCount = ref(0);

const createThumbnailUrl = (blob: Blob, size: number = 120): Promise<string> => {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(blob);
    img.onload = () => {
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        URL.revokeObjectURL(url);
        reject(new Error('Canvas context not available'));
        return;
      }

      let width = img.width;
      let height = img.height;
      if (width > height) {
        if (width > size) {
          height *= size / width;
          width = size;
        }
      } else {
        if (height > size) {
          width *= size / height;
          height = size;
        }
      }

      canvas.width = width;
      canvas.height = height;
      ctx.drawImage(img, 0, 0, width, height);
      
      URL.revokeObjectURL(url);
      
      // Use toBlob + createObjectURL: significantly faster and more memory efficient than toDataURL
      canvas.toBlob((thumbnailBlob) => {
        if (thumbnailBlob) {
          resolve(URL.createObjectURL(thumbnailBlob));
        } else {
          reject(new Error('Canvas toBlob failed'));
        }
      }, 'image/jpeg', 0.7);
    };
    img.onerror = (e) => {
      URL.revokeObjectURL(url);
      reject(e);
    };
    img.src = url;
  });
};

const loadThumbnail = async (obj: BinaryObject) => {
  if (thumbnails.value[obj.id] || thumbnailLoading.value.has(obj.id)) return;
  if (!obj.mimeType.startsWith('image/')) return;

  thumbnailLoading.value.add(obj.id);
  try {
    await thumbnailSemaphore.run(async () => {
      const blob = await storageService.getFile(obj.id);
      if (blob) {
        // requestIdleCallback (with fallback) to avoid blocking the main thread during scroll
        const scheduleWork = window.requestIdleCallback || ((cb) => setTimeout(cb, 1));
        
        const thumbUrl = await new Promise<string>((resolve, reject) => {
          scheduleWork(async () => {
            try {
              resolve(await createThumbnailUrl(blob));
            } catch (e) {
              reject(e);
            }
          });
        });
        
        if (!thumbnails.value[obj.id]) {
          thumbnails.value[obj.id] = thumbUrl;
          thumbnailCount.value++;
        }
      }
    });
  } catch (e) {
    console.error('Failed to load thumbnail:', e);
  } finally {
    thumbnailLoading.value.delete(obj.id);
  }
};

// Debounced memory cleanup
let cleanupTimeout: number | null = null;
const performThumbnailCleanup = () => {
  if (thumbnailCount.value <= 300) return;
  
  const idsToDelete: string[] = [];
  for (const id in thumbnails.value) {
    if (!visibleIds.has(id)) {
      idsToDelete.push(id);
    }
    if (thumbnailCount.value - idsToDelete.length <= 200) break;
  }

  for (const id of idsToDelete) {
    const url = thumbnails.value[id];
    if (url) URL.revokeObjectURL(url); // Clean up browser memory
    delete thumbnails.value[id];
    thumbnailCount.value--;
  }
};

// Intersection Observers
let itemObserver: IntersectionObserver | null = null;
let sentinelObserver: IntersectionObserver | null = null;
const observedElements = new WeakSet<HTMLElement>();

onMounted(() => {
  fetchObjects();

  // 1. Sentinel
  sentinelObserver = new IntersectionObserver((entries) => {
    const entry = entries[0];
    if (entry?.isIntersecting && !isLoading.value) {
      loadMore();
    }
  }, { threshold: 0, rootMargin: '800px' });

  watch(loadMoreSentinel, (el) => {
    if (el) sentinelObserver?.observe(el);
  }, { immediate: true });

  // 2. Individual items
  itemObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      const target = entry.target as HTMLElement;
      const id = target.dataset.id;
      if (!id) return;

      if (entry.isIntersecting) {
        visibleIds.add(id);
        const obj = objectMap.value.get(id);
        if (obj) loadThumbnail(obj);
      } else {
        visibleIds.delete(id);
        if (thumbnailCount.value > 300) {
          if (cleanupTimeout) clearTimeout(cleanupTimeout);
          cleanupTimeout = window.setTimeout(performThumbnailCleanup, 3000);
        }
      }
    });
  }, { threshold: 0, rootMargin: '1000px 0px' }); // Generous margin for items
});

onUnmounted(() => {
  // Revoke all Object URLs to prevent memory leaks
  for (const id in thumbnails.value) {
    const url = thumbnails.value[id];
    if (url) URL.revokeObjectURL(url);
  }
});

const registerObserver = (el: HTMLElement | null, id: string) => {
  if (el && itemObserver && !observedElements.has(el)) {
    el.dataset.id = id;
    itemObserver.observe(el);
    observedElements.add(el);
  }
};

// Cleanup on data removal
watch(objects, (newObjs, oldObjs) => {
  const newIds = new Set(newObjs.map(o => o.id));
  if (oldObjs) {
    for (const oldObj of oldObjs) {
      if (!newIds.has(oldObj.id)) {
        const url = thumbnails.value[oldObj.id];
        if (url) URL.revokeObjectURL(url);
        delete thumbnails.value[oldObj.id];
        thumbnailCount.value--;
      }
    }
  }
});

defineExpose({
  thumbnailCount,
  displayLimit,
  thumbnails,
  __testOnly: {
    // Export internal state and logic used only for testing here. Do not reference these in production logic.
  },
});
</script>

<template>
  <div class="space-y-6 animate-in fade-in slide-in-from-bottom-2 duration-400">
    <!-- Header Section -->
    <div class="flex flex-col gap-6">
      <div class="flex items-center justify-between border-b border-gray-100 dark:border-gray-800 pb-4">
        <div class="flex items-center gap-3">
          <div class="p-2 bg-blue-50 dark:bg-blue-900/20 rounded-xl">
            <HardDrive class="w-5 h-5 text-blue-500" />
          </div>
          <div>
            <div class="flex items-center gap-2">
              <h2 class="text-lg font-bold text-gray-800 dark:text-white tracking-tight">Binary Objects</h2>
              <span 
                data-testid="binary-objects-count"
                class="px-2 py-0.5 text-[10px] font-bold bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400 rounded-full"
              >
                {{ filteredObjects.length }} / {{ objects.length }}
              </span>
            </div>
            <p class="text-xs font-medium text-gray-500 dark:text-gray-400">Manage and browse persisted files</p>
          </div>
        </div>
        
        <div class="flex items-center gap-2">
          <div class="bg-gray-100 dark:bg-gray-800 rounded-xl p-1 flex">
            <button 
              @click="viewMode = 'grid'" 
              class="p-1.5 rounded-lg transition-all"
              :class="viewMode === 'grid' ? 'bg-white dark:bg-gray-700 shadow-sm text-blue-500' : 'text-gray-400 hover:text-gray-600'"
              data-testid="view-mode-grid"
            >
              <LayoutGrid class="w-4 h-4" />
            </button>
            <button 
              @click="viewMode = 'table'" 
              class="p-1.5 rounded-lg transition-all"
              :class="viewMode === 'table' ? 'bg-white dark:bg-gray-700 shadow-sm text-blue-500' : 'text-gray-400 hover:text-gray-600'"
              data-testid="view-mode-table"
            >
              <List class="w-4 h-4" />
            </button>
          </div>
          <button 
            @click="fetchObjects" 
            class="p-2 text-gray-400 hover:text-blue-500 transition-colors"
            :class="{ 'animate-spin': isLoading }"
            data-testid="refresh-objects"
          >
            <RefreshCw class="w-4 h-4" />
          </button>
        </div>
      </div>

      <!-- Controls -->
      <div class="flex gap-4">
        <div class="relative flex-1 group">
          <Search class="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 group-focus-within:text-blue-500 transition-colors" />
          <input 
            v-model="searchQuery"
            type="text" 
            placeholder="Search by name, ID, or type..."
            class="w-full pl-10 pr-4 py-2.5 bg-gray-50/50 dark:bg-gray-800/30 border border-gray-100 dark:border-gray-700 rounded-2xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all dark:text-gray-200"
            data-testid="binary-search-input"
          >
        </div>
      </div>
    </div>

    <!-- Main Content -->
    <div class="bg-white dark:bg-gray-900 border border-gray-100 dark:border-gray-800 rounded-3xl overflow-hidden shadow-sm transition-all duration-300">
      <!-- Table View -->
      <div v-if="viewMode === 'table'" class="overflow-x-auto">
        <table class="w-full text-left border-collapse min-w-[700px]">
          <thead>
            <tr class="bg-gray-50/50 dark:bg-black/20 border-b border-gray-100 dark:border-gray-800 sticky top-0 z-10">
              <th @click="handleSort('name')" class="px-6 py-3 cursor-pointer hover:bg-gray-100/50 dark:hover:bg-white/5 transition-colors group">
                <div class="flex items-center gap-2 text-[10px] font-bold text-gray-400 tracking-widest">
                  Name
                  <span class="transition-opacity" :class="sortBy === 'name' ? 'opacity-100' : 'opacity-0 group-hover:opacity-50'">
                    <ArrowUp v-if="sortBy === 'name' && sortOrder === 'asc'" class="w-3 h-3 text-blue-500" />
                    <ArrowDown v-else class="w-3 h-3 text-blue-500" />
                  </span>
                </div>
              </th>
              <th @click="handleSort('size')" class="px-6 py-3 cursor-pointer hover:bg-gray-100/50 dark:hover:bg-white/5 transition-colors group">
                <div class="flex items-center gap-2 text-[10px] font-bold text-gray-400 tracking-widest">
                  Size
                  <span class="transition-opacity" :class="sortBy === 'size' ? 'opacity-100' : 'opacity-0 group-hover:opacity-50'">
                    <ArrowUp v-if="sortBy === 'size' && sortOrder === 'asc'" class="w-3 h-3 text-blue-500" />
                    <ArrowDown v-else class="w-3 h-3 text-blue-500" />
                  </span>
                </div>
              </th>
              <th @click="handleSort('createdAt')" class="px-6 py-3 cursor-pointer hover:bg-gray-100/50 dark:hover:bg-white/5 transition-colors group">
                <div class="flex items-center gap-2 text-[10px] font-bold text-gray-400 tracking-widest">
                  Date
                  <span class="transition-opacity" :class="sortBy === 'createdAt' ? 'opacity-100' : 'opacity-0 group-hover:opacity-50'">
                    <ArrowUp v-if="sortBy === 'createdAt' && sortOrder === 'asc'" class="w-3 h-3 text-blue-500" />
                    <ArrowDown v-else class="w-3 h-3 text-blue-500" />
                  </span>
                </div>
              </th>
              <th class="px-6 py-3 text-right"></th>
            </tr>
          </thead>
          <tbody class="divide-y divide-gray-50 dark:divide-gray-800">
            <tr v-if="isLoading && objects.length === 0">
              <td colspan="4" class="px-6 py-12 text-center opacity-40 italic text-sm">Loading objects...</td>
            </tr>
            <tr v-else-if="filteredObjects.length === 0">
              <td colspan="4" class="px-6 py-12 text-center opacity-40 italic text-sm">No objects found</td>
            </tr>
            <tr 
              v-for="obj in renderedObjects" 
              :key="obj.id"
              :ref="el => registerObserver(el as HTMLElement, obj.id)"
              @click="handlePreview(obj)"
              class="group cursor-pointer hover:bg-blue-50/30 dark:hover:bg-blue-900/5 transition-colors"
              :data-testid="`binary-object-row-${obj.id}`"
            >
              <td class="px-6 py-3">
                <div class="flex items-center gap-3 min-w-0">
                  <div class="w-10 h-10 flex items-center justify-center bg-gray-50 dark:bg-gray-800 rounded-lg shrink-0 overflow-hidden border border-gray-100 dark:border-gray-700">
                    <img 
                      v-if="thumbnails[obj.id]" 
                      :src="thumbnails[obj.id]" 
                      class="w-full h-full object-cover" 
                      :data-testid="`binary-thumbnail-${obj.id}`"
                    />
                    <div v-else class="flex items-center justify-center w-full h-full">
                      <Eye v-if="obj.mimeType.startsWith('image/')" class="w-4 h-4 text-blue-500 opacity-50" />
                      <File v-else class="w-4 h-4 text-gray-400" />
                    </div>
                  </div>
                  <div class="flex flex-col min-w-0">
                    <span class="text-sm font-bold text-gray-700 dark:text-gray-200 truncate">{{ obj.name || 'Unnamed' }}</span>
                    <span class="text-[9px] font-medium text-gray-400 truncate lowercase">{{ obj.mimeType }}</span>
                  </div>
                </div>
              </td>
              <td class="px-6 py-3">
                <span class="text-[11px] font-bold text-gray-500">{{ formatSize(obj.size) }}</span>
              </td>
              <td class="px-6 py-3">
                <span class="text-[11px] font-medium text-gray-400 whitespace-nowrap">{{ formatDate(obj.createdAt) }}</span>
              </td>
              <td class="px-6 py-3 text-right">
                <div class="flex items-center justify-end gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                  <button 
                    @click.stop="handleDownload(obj)" 
                    class="p-2 text-gray-400 hover:text-green-500 hover:bg-green-50 dark:hover:bg-green-900/30 rounded-lg transition-colors" 
                    title="Download"
                    :data-testid="`download-button-${obj.id}`"
                  >
                    <Download class="w-4 h-4" />
                  </button>
                  <button 
                    @click.stop="handleDelete(obj)" 
                    class="p-2 text-gray-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/10 rounded-lg transition-colors" 
                    title="Delete"
                    :data-testid="`delete-button-${obj.id}`"
                  >
                    <Trash2 class="w-4 h-4" />
                  </button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- Grid/Thumbnail View -->
      <div v-else class="p-6 grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
        <div v-if="isLoading && objects.length === 0" class="col-span-full py-20 text-center opacity-40 italic text-sm">Loading objects...</div>
        <div v-else-if="filteredObjects.length === 0" class="col-span-full py-20 text-center opacity-40 italic text-sm">No objects found</div>
        
        <div 
          v-for="obj in renderedObjects" 
          :key="obj.id"
          :ref="el => registerObserver(el as HTMLElement, obj.id)"
          @click="handlePreview(obj)"
          class="group relative aspect-square bg-gray-50 dark:bg-gray-800 rounded-2xl overflow-hidden cursor-pointer border-2 border-transparent hover:border-blue-500 hover:shadow-lg transition-all"
          :data-testid="`binary-object-grid-${obj.id}`"
        >
          <!-- Thumbnail -->
          <div class="absolute inset-0 flex items-center justify-center p-4">
            <img 
              v-if="thumbnails[obj.id]" 
              :src="thumbnails[obj.id]" 
              class="w-full h-full object-contain transition-transform group-hover:scale-110" 
              :data-testid="`binary-thumbnail-${obj.id}`"
            />
            <div v-else class="flex flex-col items-center gap-2 opacity-40">
              <Eye v-if="obj.mimeType.startsWith('image/')" class="w-8 h-8 text-blue-500" />
              <File v-else class="w-8 h-8 text-gray-400" />
              <span class="text-[10px] font-bold truncate max-w-[80px] lowercase">{{ obj.mimeType.split('/')[1] }}</span>
            </div>
          </div>

          <!-- Overlay Info -->
          <div class="absolute inset-x-0 bottom-0 p-2 bg-gradient-to-t from-black/60 to-transparent opacity-0 group-hover:opacity-100 transition-opacity">
            <p class="text-[10px] font-bold text-white truncate">{{ obj.name || 'Unnamed' }}</p>
            <p class="text-[9px] text-white/70">{{ formatSize(obj.size) }}</p>
          </div>
        </div>
      </div>
      
      <!-- Infinite scroll sentinel -->
      <div 
        ref="loadMoreSentinel" 
        class="h-12 w-full flex items-center justify-center border-t border-gray-50 dark:border-gray-800"
      >
        <button 
          v-if="displayLimit < filteredObjects.length" 
          @click="loadMore"
          class="text-[10px] font-bold text-gray-400 hover:text-blue-500 transition-colors py-2 px-4 rounded-full hover:bg-gray-50 dark:hover:bg-white/5"
          data-testid="load-more-button"
        >
          Loading more... (click to load manually)
        </button>
      </div>
    </div>
    <!-- Preview Modal -->
    <BinaryObjectPreviewModal
      v-if="previewState"
      :objects="previewState.objects"
      :initial-id="previewState.initialId"
      @close="closePreview"
      @delete="(obj: BinaryObject) => handleDelete(obj)"
      @download="(obj: BinaryObject) => handleDownload(obj)"
    />
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
/* Ensure table layout is stable */
table {
  table-layout: fixed;
}
</style>
