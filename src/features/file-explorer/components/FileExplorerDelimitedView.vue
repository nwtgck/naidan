<script setup lang="ts">
import { computed, nextTick, ref, shallowRef, watch } from 'vue';
import {
  DELIMITED_TEXT_LIMITS,
  parseDelimitedText,
  replaceDelimitedTextCells,
  type DelimitedTextCell,
  type DelimitedTextFormat,
} from '@/features/file-explorer/logic/delimited-text';
import { lazyStrings } from '@/strings';

const props = defineProps<{
  text: string;
  format: DelimitedTextFormat;
  mode: 'preview' | 'detail';
  partial: boolean;
  editable: boolean;
  saving?: boolean;
}>();

const emit = defineEmits<{
  save: [payload: { text: string }];
  dirtyChange: [payload: { dirty: boolean }];
}>();

const detailPageSize = 40;
const rowCount = ref(detailPageSize);
const editingCell = shallowRef<DelimitedTextCell>();
const changes = ref(new Map<DelimitedTextCell, string>());
const hasChanges = computed(() => changes.value.size > 0);
const parsed = computed(() => parseDelimitedText({
  text: props.text,
  format: props.format,
  partial: props.partial,
  limits: DELIMITED_TEXT_LIMITS[props.mode],
}));
const canEdit = computed(() => (
  props.mode === 'detail' &&
  props.editable &&
  parsed.value.status === 'parsed' &&
  !parsed.value.truncated
));
const rows = computed(() => {
  const result = parsed.value;
  switch (result.status) {
  case 'parsed':
    return result.rows.slice(0, rowCount.value);
  case 'invalid':
    return [];
  default: {
    const exhaustive: never = result;
    throw new Error(`Unexpected delimited text result: ${String(exhaustive)}`);
  }
  }
});
const columnCount = computed(() => rows.value.reduce((count, row) => Math.max(count, row.length), 0));
const fallbackText = computed(() => props.text.slice(0, DELIMITED_TEXT_LIMITS.preview.characters));

watch(hasChanges, (dirty) => emit('dirtyChange', { dirty }));
watch(() => [props.text, props.format, props.mode], () => {
  changes.value.clear();
  editingCell.value = undefined;
  rowCount.value = detailPageSize;
});

function cellValue({ cell }: { cell: DelimitedTextCell }): string {
  return changes.value.get(cell) ?? cell.value;
}

async function startEditing({ cell, event }: { cell: DelimitedTextCell; event: MouseEvent }): Promise<void> {
  if (!canEdit.value || props.saving) {
    return;
  }
  const target = event.currentTarget;
  if (!(target instanceof HTMLButtonElement)) {
    return;
  }
  const container = target.parentElement;
  editingCell.value = cell;
  await nextTick();
  container?.querySelector('textarea')?.focus();
}

function stopEditing({ cell }: { cell: DelimitedTextCell }): void {
  if (editingCell.value === cell) {
    editingCell.value = undefined;
  }
}

async function returnToCell({ cell, event }: { cell: DelimitedTextCell; event: KeyboardEvent }): Promise<void> {
  if (event.isComposing) {
    return;
  }
  event.preventDefault();
  const target = event.currentTarget;
  const container = target instanceof HTMLTextAreaElement ? target.parentElement : undefined;
  stopEditing({ cell });
  await nextTick();
  container?.querySelector('button')?.focus();
}

function updateCell({ cell, event }: { cell: DelimitedTextCell; event: Event }): void {
  const target = event.target;
  if (!canEdit.value || props.saving || !(target instanceof HTMLTextAreaElement)) {
    return;
  }
  if (target.value === cell.value) {
    changes.value.delete(cell);
  } else {
    changes.value.set(cell, target.value);
  }
}

function getDraft(): string | undefined {
  return hasChanges.value ? replaceDelimitedTextCells({ text: props.text, format: props.format, changes: changes.value }) : undefined;
}

function save(): void {
  if (!canEdit.value || props.saving) {
    return;
  }
  const text = getDraft();
  if (text !== undefined) {
    emit('save', { text });
  }
}

defineExpose({
  getDraft,
  ...((__BUILD_MODE_IS_TEST__ && {
    TEST_ONLY: {
      // Export internal state and logic used only for testing here. Do not reference these in production logic.
      // ESLint-required for defineExpose.
    },
  }) || {}),
});
</script>

<template>
  <section tw-class="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden" data-testid="delimited-view">
    <template v-if="parsed.status === 'invalid'">
      <p tw-class="px-3 py-2 text-xs text-gray-600 dark:text-gray-400" data-testid="delimited-fallback-notice">
        {{ lazyStrings.FileExplorerDelimitedView__could_not_display_as_a_table() }}
      </p>
      <p
        v-if="partial || fallbackText.length < text.length"
        tw-class="px-3 text-xs text-gray-600 dark:text-gray-400"
      >
        {{ lazyStrings.FileExplorerDelimitedView__showing_part_of_the_file() }}
      </p>
      <pre tw-class="min-h-0 flex-1 overflow-auto px-3 py-2 text-xs text-gray-800 dark:text-gray-200" data-testid="delimited-fallback">{{ fallbackText }}</pre>
    </template>
    <template v-else>
      <p v-if="parsed.truncated" tw-class="shrink-0 px-3 py-2 text-xs text-gray-600 dark:text-gray-400" data-testid="delimited-partial">
        {{ lazyStrings.FileExplorerDelimitedView__showing_part_of_the_file() }}
      </p>
      <p v-if="!rows.length" tw-class="px-3 py-2 text-xs text-gray-600 dark:text-gray-400">
        {{ lazyStrings.FileExplorerDelimitedView__no_complete_rows_to_display() }}
      </p>
      <div v-else tw-class="min-h-0 flex-1 overflow-auto overscroll-contain">
        <table tw-class="w-max min-w-full border-collapse text-xs text-gray-800 dark:text-gray-200" data-testid="delimited-table">
          <thead tw-class="sticky top-0 z-10 bg-gray-100 dark:bg-gray-800">
            <tr>
              <th scope="col" tw-class="border-b border-r border-gray-200 px-3 py-1 text-right font-normal text-gray-500 dark:border-gray-700 dark:text-gray-400">#</th>
              <th
                v-for="column in columnCount"
                :key="column"
                scope="col"
                tw-class="border-b border-r border-gray-200 px-3 py-1 text-left font-normal text-gray-500 dark:border-gray-700 dark:text-gray-400"
              >
                {{ column }}
              </th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(row, rowIndex) in rows" :key="rowIndex" data-testid="delimited-row">
              <th scope="row" tw-class="border-b border-r border-gray-200 px-3 py-1 text-right align-top font-normal text-gray-500 dark:border-gray-700 dark:text-gray-400">
                {{ rowIndex + 1 }}
              </th>
              <td
                v-for="(cell, columnIndex) in row"
                :key="cell.start"
                tw-class="max-w-60 border-b border-r border-gray-200 px-3 py-1 align-top dark:border-gray-700"
              >
                <textarea
                  v-if="canEdit && editingCell === cell"
                  :value="cellValue({ cell })"
                  :aria-label="lazyStrings.FileExplorerDelimitedView__row_column({ row: rowIndex + 1, column: columnIndex + 1 })"
                  :disabled="saving"
                  data-testid="delimited-cell-input"
                  rows="2"
                  tw-class="block min-w-32 resize-y rounded border border-blue-500 bg-white px-1 outline-none dark:bg-gray-900"
                  @input="updateCell({ cell, event: $event })"
                  @blur="stopEditing({ cell })"
                  @keydown.stop
                  @keydown.esc="returnToCell({ cell, event: $event })"
                />
                <button
                  v-else-if="canEdit"
                  type="button"
                  :aria-label="cellValue({ cell }) ? undefined : lazyStrings.FileExplorerDelimitedView__row_column({ row: rowIndex + 1, column: columnIndex + 1 })"
                  :disabled="saving"
                  data-testid="delimited-cell-button"
                  tw-class="block min-w-10 max-w-full rounded text-left break-words whitespace-pre-wrap hover:bg-blue-50 focus-visible:outline-2 focus-visible:outline-blue-500 dark:hover:bg-gray-800"
                  @click="startEditing({ cell, event: $event })"
                >
                  {{ cellValue({ cell }) || '\u00a0' }}
                </button>
                <span v-else tw-class="block break-words whitespace-pre-wrap">{{ cellValue({ cell }) }}</span>
              </td>
            </tr>
          </tbody>
        </table>
        <button
          v-if="rowCount < parsed.rows.length"
          type="button"
          data-testid="delimited-show-more"
          tw-class="m-3 rounded border border-gray-200 px-3 py-1.5 text-xs text-gray-700 hover:bg-gray-100 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
          @click="rowCount += detailPageSize"
        >
          {{ lazyStrings.FileExplorerDelimitedView__show_more_rows() }}
        </button>
      </div>
      <div v-if="canEdit" tw-class="flex shrink-0 justify-end border-t border-gray-200 px-3 py-2 dark:border-gray-700">
        <button
          type="button"
          :disabled="!hasChanges || saving"
          data-testid="delimited-save"
          tw-class="rounded bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-500 disabled:opacity-50"
          @click="save"
        >
          {{ lazyStrings.FileExplorerDelimitedView__save_table_changes() }}
        </button>
      </div>
    </template>
  </section>
</template>
