<script setup lang="ts">
import { inject, ref } from 'vue';
import { ChevronRightIcon, ChevronLeftIcon } from 'lucide-vue-next';
import { FILE_EXPLORER_INJECTION_KEY } from './useFileExplorer';

const ctx = inject(FILE_EXPLORER_INJECTION_KEY)!;

const isEditingPath = ref(false);
const editPathValue = ref('');

function startPathEdit(): void {
  editPathValue.value = ctx.pathSegments.map(s => s.name).join(' / ');
  isEditingPath.value = true;
}

function cancelPathEdit(): void {
  isEditingPath.value = false;
}

async function confirmPathEdit(): Promise<void> {
  isEditingPath.value = false;
  const parts = editPathValue.value.split('/').map(p => p.trim()).filter(Boolean);
  if (parts.length === 0) return;

  try {
    const startIdx = parts[0] === ctx.pathSegments[0]?.name ? 1 : 0;
    const targetPath = startIdx >= parts.length ? '/' : `/${parts.slice(startIdx).join('/')}`;
    await ctx.navigateToDirectory({ path: targetPath });
    ctx.applySelection({ action: { type: 'clear' } });
  } catch {
    // Invalid path — silently ignore
  }
}

function onPathKeyDown({ event }: { event: KeyboardEvent }): void {
  if (event.key === 'Enter') {
    confirmPathEdit();
  } else if (event.key === 'Escape') {
    cancelPathEdit();
  }
}


defineExpose({
  TEST_ONLY: {
    // Export internal state and logic used only for testing here. Do not reference these in production logic.
  }
});
</script>

<template>
  <div class="flex items-center gap-1 min-w-0 flex-1">
    <!-- Back button -->
    <button
      :disabled="ctx.pathSegments.length <= 1"
      class="p-1.5 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-700 disabled:opacity-30 transition-colors shrink-0"
      title="Go Back"
      data-testid="breadcrumb-back"
      @click="ctx.navigateUp()"
    >
      <ChevronLeftIcon class="w-3.5 h-3.5 text-gray-500" />
    </button>

    <!-- Editable path bar -->
    <input
      v-if="isEditingPath"
      v-model="editPathValue"
      class="flex-1 px-2 py-1 text-xs bg-white dark:bg-gray-800 border border-blue-500 rounded-lg outline-none focus:ring-2 focus:ring-blue-500/20 text-gray-800 dark:text-gray-200"
      data-testid="path-input"
      @keydown="onPathKeyDown({ event: $event })"
      @blur="cancelPathEdit"
    />

    <!-- Breadcrumb segments -->
    <div
      v-else
      class="flex items-center gap-0.5 overflow-hidden min-w-0 cursor-text flex-1"
      data-testid="breadcrumb-bar"
      @dblclick="startPathEdit"
    >
      <template v-for="(seg, i) in ctx.pathSegments" :key="i">
        <button
          v-if="i < ctx.pathSegments.length - 1"
          class="px-1.5 py-0.5 text-[11px] text-gray-500 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800 rounded transition-colors shrink-0 max-w-[120px] truncate"
          :title="seg.name"
          :data-testid="`breadcrumb-${i}`"
          @click="ctx.jumpToBreadcrumb({ index: i })"
        >
          {{ seg.name }}
        </button>
        <ChevronRightIcon
          v-if="i < ctx.pathSegments.length - 1"
          class="w-3 h-3 text-gray-300 dark:text-gray-600 shrink-0"
        />
        <span
          v-if="i === ctx.pathSegments.length - 1"
          class="px-1.5 py-0.5 text-[11px] font-bold text-gray-800 dark:text-gray-200 truncate"
          :data-testid="`breadcrumb-current`"
        >
          {{ seg.name }}
        </span>
      </template>
    </div>
  </div>
</template>
