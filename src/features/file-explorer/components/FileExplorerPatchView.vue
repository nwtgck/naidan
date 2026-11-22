<script setup lang="ts">
import { computed } from 'vue';
import { fileExplorerTextWrap } from '@/features/file-explorer/composables/file-explorer-text-wrap';
import { buildPatchView } from '@/features/file-explorer/logic/patch-view';
import { lazyStrings } from '@/strings';

const props = defineProps<{ text: string }>();
const patch = computed(() => buildPatchView({ text: props.text }));

defineExpose({
  ...((__BUILD_MODE_IS_TEST__ && {
    TEST_ONLY: {
      // Export internal state and logic used only for testing here. Do not reference these in production logic.
    },
  }) || {}),
});
</script>

<template>
  <div tw-class="flex-1 min-h-0 min-w-0 overflow-auto" data-testid="file-explorer-patch-view">
    <template v-if="patch.kind === 'structured'">
      <section
        v-for="(file, fileIndex) in patch.files"
        :key="fileIndex"
        tw-class="border-b border-gray-200 dark:border-gray-800"
        data-testid="patch-file"
      >
        <h3
          v-if="file.oldPath || file.newPath"
          tw-class="break-all border-b border-gray-200 bg-gray-50 px-3 py-2 font-mono text-xs font-semibold dark:border-gray-800 dark:bg-gray-900/60"
        >
          <template v-if="file.oldPath && file.newPath && file.oldPath !== file.newPath">
            {{ file.oldPath }} → {{ file.newPath }}
          </template>
          <template v-else>{{ file.newPath ?? file.oldPath }}</template>
        </h3>
        <table tw-class="w-full border-collapse font-mono text-xs leading-5">
          <thead tw-class="sr-only">
            <tr>
              <th scope="col">{{ lazyStrings.FileExplorerPatchView__old_line() }}</th>
              <th scope="col">{{ lazyStrings.FileExplorerPatchView__new_line() }}</th>
              <th scope="col" colspan="2">{{ lazyStrings.FileExplorerPatchView__change() }}</th>
            </tr>
          </thead>
          <tbody v-for="(hunk, hunkIndex) in file.hunks" :key="hunkIndex" data-testid="patch-hunk">
            <tr>
              <th
                colspan="4"
                scope="rowgroup"
                :tw-class="['bg-blue-50 px-3 py-1 text-left font-normal text-blue-900 dark:bg-blue-950/50 dark:text-blue-200', fileExplorerTextWrap ? 'whitespace-pre-wrap wrap-anywhere' : 'whitespace-pre']"
              >{{ hunk.label }}</th>
            </tr>
            <template v-for="(row, rowIndex) in hunk.rows" :key="rowIndex">
              <tr
                :data-change="row.kind"
                :tw-class="{
                  'bg-emerald-50 dark:bg-emerald-950/45': row.kind === 'add',
                  'bg-red-50 dark:bg-red-950/45': row.kind === 'remove',
                }"
                data-testid="patch-row"
              >
                <td
                  tw-class="w-px min-w-8 select-none border-r border-gray-200 px-2 text-right align-top text-gray-500 dark:border-gray-800 dark:text-gray-400"
                  data-testid="patch-old-line"
                >{{ row.oldLine }}</td>
                <td
                  tw-class="w-px min-w-8 select-none border-r border-gray-200 px-2 text-right align-top text-gray-500 dark:border-gray-800 dark:text-gray-400"
                  data-testid="patch-new-line"
                >{{ row.newLine }}</td>
                <td tw-class="w-px min-w-6 select-none px-2 align-top font-semibold">
                  <span v-if="row.kind === 'add'" tw-class="text-emerald-800 dark:text-emerald-300">+</span>
                  <span v-else-if="row.kind === 'remove'" tw-class="text-red-800 dark:text-red-300">−</span>
                </td>
                <td :tw-class="['pr-3 align-top', fileExplorerTextWrap ? 'whitespace-pre-wrap wrap-anywhere' : 'whitespace-pre']">
                  <code data-testid="patch-line-text"><span
                    v-for="(token, tokenIndex) in row.tokens"
                    :key="tokenIndex"
                    :data-syntax="token.kind"
                    :tw-class="{
                      'text-purple-700 dark:text-purple-300': token.kind === 'keyword',
                      'text-gray-600 dark:text-gray-400': token.kind === 'comment',
                      'text-emerald-800 dark:text-emerald-300': token.kind === 'string',
                      'text-amber-800 dark:text-amber-300': token.kind === 'variable',
                      'text-gray-600 dark:text-gray-300': token.kind === 'operator',
                      'text-blue-700 dark:text-blue-300': token.kind === 'command',
                    }"
                  >{{ token.text }}</span></code>
                </td>
              </tr>
              <tr v-if="row.terminator === 'none'">
                <td colspan="3"></td>
                <td tw-class="pr-3 text-gray-500 dark:text-gray-400">{{ lazyStrings.FileExplorerPatchView__no_newline_at_end_of_file() }}</td>
              </tr>
            </template>
          </tbody>
        </table>
      </section>
    </template>
    <template v-else>
      <p tw-class="border-b border-gray-200 p-3 text-xs text-gray-600 dark:border-gray-800 dark:text-gray-400">
        {{ lazyStrings.FileExplorerPatchView__showing_source() }}
      </p>
      <pre :tw-class="['p-3 text-xs leading-5', fileExplorerTextWrap ? 'whitespace-pre-wrap wrap-anywhere' : 'min-w-max whitespace-pre']" data-testid="patch-source">{{ text }}</pre>
    </template>
  </div>
</template>
