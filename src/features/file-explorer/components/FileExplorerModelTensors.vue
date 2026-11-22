<script setup lang="ts">
import { computed, ref, shallowRef, watch } from 'vue';
import { ChevronDownIcon, ChevronRightIcon } from 'lucide-vue-next';
import { lazyStrings } from '@/strings';
import type { ModelTensorDescriptor } from '@/logic/model-file-inspection/metadata';

type TensorRows = { rows: TensorRow[], groups: Map<string, TensorGroup> };
type TensorGroup = {
  kind: 'group',
  key: string,
  label: string,
  depth: number,
  count: number,
  children: TensorRows,
};
type TensorRow = TensorGroup | { kind: 'tensor', tensor: ModelTensorDescriptor, depth: number };

const props = defineProps<{ tensors: readonly ModelTensorDescriptor[], compact?: boolean }>();
const pageSize = 40;
const query = ref('');
const page = ref(0);
const expanded = shallowRef<ReadonlySet<string>>(new Set());

function createRows(): TensorRows {
  return { rows: [], groups: new Map() };
}

const rows = computed<TensorRow[]>(() => {
  const normalizedQuery = query.value.trim().toLowerCase();
  if (normalizedQuery !== '') {
    return props.tensors
      .filter(tensor => tensor.name.toLowerCase().includes(normalizedQuery))
      .map(tensor => ({ kind: 'tensor', tensor, depth: 0 }));
  }

  const root = createRows();
  for (const tensor of props.tensors) {
    let node = root;
    let start = 0;
    let depth = 0;
    while (true) {
      const dot = tensor.name.indexOf('.', start);
      if (dot <= start) {
        node.rows.push({ kind: 'tensor', tensor, depth });
        break;
      }
      const label = tensor.name.slice(start, dot);
      let group = node.groups.get(label);
      if (group === undefined) {
        group = {
          kind: 'group',
          key: tensor.name.slice(0, dot + 1),
          label,
          depth,
          count: 0,
          children: createRows(),
        };
        node.groups.set(label, group);
        node.rows.push(group);
      }
      group.count += 1;
      if (!expanded.value.has(group.key)) {
        break;
      }
      node = group.children;
      start = dot + 1;
      depth += 1;
    }
  }
  const result: TensorRow[] = [];
  const stack = [root.rows.values()];
  while (stack.length > 0) {
    const iterator = stack.at(-1);
    const item = iterator?.next();
    if (!item || item.done) {
      stack.pop();
      continue;
    }
    result.push(item.value);
    if (item.value.kind === 'group' && item.value.children.rows.length > 0) {
      stack.push(item.value.children.rows.values());
    }
  }
  return result;
});

const lastPage = computed(() => Math.max(0, Math.ceil(rows.value.length / pageSize) - 1));
const visibleRows = computed(() => rows.value.slice(page.value * pageSize, (page.value + 1) * pageSize));

watch(query, () => {
  page.value = 0;
});
watch(lastPage, limit => {
  page.value = Math.min(page.value, limit);
});
watch(() => props.tensors, () => {
  expanded.value = new Set();
  page.value = 0;
});

function toggleGroup({ key }: { key: string }): void {
  const next = new Set(expanded.value);
  if (next.has(key)) {
    next.delete(key);
  } else {
    next.add(key);
  }
  expanded.value = next;
}

function tensorType({ tensor }: { tensor: ModelTensorDescriptor }): string {
  return tensor.dtypeCode === undefined ? tensor.dtype : `${tensor.dtype} (#${tensor.dtypeCode})`;
}


defineExpose({
  ...((__BUILD_MODE_IS_TEST__ && {
    TEST_ONLY: {
      // Export internal state and logic used only for testing here. Do not reference these in production logic.
      // ESLint-required for defineExpose.
    },
  }) || {}),
});
</script>

<template>
  <div tw-class="flex min-h-0 flex-1 flex-col gap-2 p-3" data-testid="model-tensors">
    <div tw-class="flex flex-wrap items-center gap-2">
      <input
        v-model="query"
        type="search"
        data-testid="model-tensor-search"
        :aria-label="lazyStrings.fileExplorer__filter_by_name()"
        :placeholder="lazyStrings.fileExplorer__filter_by_name()"
        tw-class="min-w-0 max-w-sm flex-1 rounded-md border border-gray-200 bg-white px-2 py-1 text-xs focus:border-blue-500 focus:outline-none dark:border-gray-700 dark:bg-gray-900"
      />
      <div v-if="lastPage > 0" tw-class="flex shrink-0 items-center gap-2 text-xs">
        <button
          type="button"
          :disabled="page === 0"
          data-testid="model-tensor-previous"
          tw-class="rounded-md px-2 py-1 hover:bg-gray-100 disabled:opacity-40 dark:hover:bg-gray-800"
          @click="page -= 1"
        >
          {{ lazyStrings.FileExplorerModelView__previous_page() }}
        </button>
        <span>{{ page + 1 }} / {{ lastPage + 1 }}</span>
        <button
          type="button"
          :disabled="page >= lastPage"
          data-testid="model-tensor-next"
          tw-class="rounded-md px-2 py-1 hover:bg-gray-100 disabled:opacity-40 dark:hover:bg-gray-800"
          @click="page += 1"
        >
          {{ lazyStrings.FileExplorerModelView__next_page() }}
        </button>
      </div>
    </div>
    <div v-if="visibleRows.length !== 0" tw-class="min-h-0 flex-1 overflow-auto rounded-md border border-gray-200 dark:border-gray-800">
      <table :tw-class="['w-full text-left text-xs', compact ? 'table-fixed' : 'min-w-max']">
        <thead v-if="!compact" tw-class="sticky top-0 bg-gray-50 dark:bg-gray-900">
          <tr>
            <th scope="col" tw-class="px-3 py-2 font-medium">{{ lazyStrings.fileExplorer__name() }}</th>
            <th scope="col" tw-class="px-3 py-2 font-medium">{{ lazyStrings.FileExplorerModelView__tensor_shape() }}</th>
            <th scope="col" tw-class="px-3 py-2 font-medium">{{ lazyStrings.fileExplorer__type() }}</th>
            <th scope="col" tw-class="px-3 py-2 font-medium">{{ lazyStrings.FileExplorerModelView__file_offset() }}</th>
          </tr>
        </thead>
        <tbody>
          <template v-for="row in visibleRows" :key="row.kind === 'group' ? `group:${row.key}` : `tensor:${row.tensor.name}`">
            <tr v-if="row.kind === 'group'" tw-class="border-t border-gray-100 dark:border-gray-800" data-testid="model-tensor-group">
              <td :colspan="compact ? 1 : 4" tw-class="px-3 py-1">
                <button
                  type="button"
                  :aria-expanded="expanded.has(row.key)"
                  :style="{ marginInlineStart: `${row.depth}rem` }"
                  tw-class="flex items-center gap-1 rounded-lg px-1 py-1 text-left font-mono wrap-anywhere hover:bg-gray-100 dark:hover:bg-gray-800"
                  @click="toggleGroup({ key: row.key })"
                >
                  <ChevronDownIcon v-if="expanded.has(row.key)" tw-class="h-3.5 w-3.5" />
                  <ChevronRightIcon v-else tw-class="h-3.5 w-3.5" />
                  {{ row.label }}
                  <span tw-class="font-sans text-gray-500">({{ row.count }})</span>
                </button>
              </td>
            </tr>
            <tr v-else tw-class="border-t border-gray-100 font-mono dark:border-gray-800" data-testid="model-tensor-row">
              <td tw-class="px-3 py-1.5">
                <div :style="{ marginInlineStart: `${row.depth}rem` }" tw-class="wrap-anywhere">{{ row.tensor.name }}</div>
                <div v-if="compact" tw-class="mt-0.5 wrap-anywhere text-gray-500 dark:text-gray-400">
                  {{ tensorType({ tensor: row.tensor }) }} · [{{ row.tensor.shape.join(', ') }}]
                  <div v-if="row.tensor.originalShape !== undefined">
                    {{ lazyStrings.FileExplorerModelView__original_shape() }} [{{ row.tensor.originalShape.join(', ') }}]
                  </div>
                  <div>{{ lazyStrings.FileExplorerModelView__file_offset() }} {{ row.tensor.offset }}</div>
                </div>
              </td>
              <td v-if="!compact" tw-class="px-3 py-2">
                [{{ row.tensor.shape.join(', ') }}]
                <div v-if="row.tensor.originalShape !== undefined" tw-class="text-gray-500 dark:text-gray-400">
                  {{ lazyStrings.FileExplorerModelView__original_shape() }}
                  [{{ row.tensor.originalShape.join(', ') }}]
                </div>
              </td>
              <td v-if="!compact" tw-class="px-3 py-2">{{ tensorType({ tensor: row.tensor }) }}</td>
              <td v-if="!compact" tw-class="px-3 py-2">{{ row.tensor.offset }}</td>
            </tr>
          </template>
        </tbody>
      </table>
    </div>
    <p v-else tw-class="px-3 py-2 text-xs text-gray-500">{{ lazyStrings.fileExplorer__no_matching_items() }}</p>
  </div>
</template>
