<script setup lang="ts">
import { computed } from 'vue';
import type { Component } from 'vue';
import type { Token, Tokens } from 'marked';
import { marked, sanitizeHtml } from './useMarkdown'; // Added sanitizeHtml
import CodeBlockWrapper from './CodeBlockWrapper.vue';
import MarkdownInline from './MarkdownInline.vue';
import BlockMarkdownItem from './BlockMarkdownItem.vue';

// Recursive component reference
// In Vue 3 script setup, self-reference is automatic if the filename matches.
// But we might need to be explicit if using dynamic component.
// BlockMarkdownItem is available here.

const props = defineProps<{
  token: Token;
  trailingInline?: Component;
}>();

const isTaskList = computed(() => {
  if (props.token.type !== 'list') return false;
  return (props.token as Tokens.List).items.some(item => item.task);
});

// Token types that produce no visible output — used to find the last *renderable* child.
const SILENT_TYPES = new Set(['space', 'def', 'checkbox']);

function lastRenderableIdx({ tokens }: { tokens: Array<{ type: string }> | undefined }): number {
  if (!tokens || tokens.length === 0) return -1;
  for (let i = tokens.length - 1; i >= 0; i--) {
    if (!SILENT_TYPES.has(tokens[i]!.type)) return i;
  }
  return -1;
}

// For tables: find the last cell index in a row that has non-empty text content.
// During streaming, trailing cells may be empty placeholders not yet filled.
function lastNonEmptyCellIdx({ row }: { row: Tokens.TableCell[] }): number {
  for (let i = row.length - 1; i >= 0; i--) {
    if (row[i]!.text.trim() !== '') return i;
  }
  return -1;
}


defineExpose({
  __testOnly: {
    // Export internal state and logic used only for testing here. Do not reference these in production logic.
  }
});
</script>

<template>
  <!-- Code Block -->
  <CodeBlockWrapper
    v-if="token.type === 'code'"
    :code="(token as Tokens.Code).text"
    :lang="(token as Tokens.Code).lang || ''"
  />

  <!-- Heading -->
  <component
    v-else-if="token.type === 'heading'"
    :is="`h${(token as Tokens.Heading).depth}`"
    class="font-bold my-4 scroll-mt-20 text-gray-900 dark:text-gray-100"
    :class="{
      'text-2xl pb-2 border-b border-gray-200 dark:border-gray-700': (token as Tokens.Heading).depth === 1,
      'text-xl': (token as Tokens.Heading).depth === 2,
      'text-lg': (token as Tokens.Heading).depth >= 3
    }"
  >
    <MarkdownInline :text="(token as Tokens.Heading).text" mode="markdown" />
    <component :is="trailingInline" v-if="trailingInline" />
  </component>

  <!-- Paragraph -->
  <p v-else-if="token.type === 'paragraph'" class="mb-4 last:mb-0 leading-relaxed text-gray-800 dark:text-gray-300">
    <MarkdownInline :text="(token as Tokens.Paragraph).text" mode="markdown" />
    <component :is="trailingInline" v-if="trailingInline" />
  </p>

  <!-- Blockquote -->
  <blockquote v-else-if="token.type === 'blockquote'" class="border-l-4 border-gray-300 dark:border-gray-600 pl-4 my-4 italic text-gray-600 dark:text-gray-400 bg-gray-50 dark:bg-gray-800/30 py-1 pr-2 rounded-r">
    <BlockMarkdownItem
      v-for="(childToken, idx) in (token as Tokens.Blockquote).tokens"
      :key="idx"
      :token="childToken"
      :trailing-inline="idx === lastRenderableIdx({ tokens: (token as Tokens.Blockquote).tokens }) ? trailingInline : undefined"
    />
  </blockquote>

  <!-- List -->
  <component
    v-else-if="token.type === 'list'"
    :is="(token as Tokens.List).ordered ? 'ol' : 'ul'"
    class="mb-4"
    :class="{
      'list-decimal ml-6 !pl-0': (token as Tokens.List).ordered,
      'list-disc ml-6 !pl-0': !(token as Tokens.List).ordered && !isTaskList,
      'list-none ml-2 !pl-0': !((token as Tokens.List).ordered) && isTaskList
    }"
    :start="(token as Tokens.List).start || undefined"
  >
    <li
      v-for="(item, idx) in (token as Tokens.List).items"
      :key="idx"
      class="mb-1 text-gray-800 dark:text-gray-300"
      :class="{ '!pl-0': isTaskList }"
    >
      <template v-if="item.task">
        <div class="flex items-start gap-2">
          <input type="checkbox" :checked="item.checked" disabled class="mt-1 flex-shrink-0" />
          <div class="flex-1 min-w-0">
            <template v-if="item.tokens.length === 1">
              <BlockMarkdownItem
                :token="(item.tokens[0] as Token)"
                :trailing-inline="idx === (token as Tokens.List).items.length - 1 ? trailingInline : undefined"
              />
            </template>
            <template v-else>
              <BlockMarkdownItem
                v-for="(childToken, cIdx) in item.tokens"
                :key="cIdx"
                :token="childToken"
                :trailing-inline="idx === (token as Tokens.List).items.length - 1 && cIdx === lastRenderableIdx({ tokens: item.tokens }) ? trailingInline : undefined"
              />
            </template>
          </div>
        </div>
      </template>
      <template v-else>
        <!-- For normal lists, avoid any wrapper div to prevent line breaks after the bullet -->
        <template v-if="item.tokens.length === 1">
          <BlockMarkdownItem
            :token="(item.tokens[0] as Token)"
            :trailing-inline="idx === (token as Tokens.List).items.length - 1 ? trailingInline : undefined"
          />
        </template>
        <template v-else>
          <div class="inline-block w-full align-top">
            <BlockMarkdownItem
              v-for="(childToken, cIdx) in item.tokens"
              :key="cIdx"
              :token="childToken"
              :trailing-inline="idx === (token as Tokens.List).items.length - 1 && cIdx === lastRenderableIdx({ tokens: item.tokens }) ? trailingInline : undefined"
            />
          </div>
        </template>
      </template>
    </li>
  </component>

  <!-- Table -->
  <div v-else-if="token.type === 'table'" class="not-prose overflow-x-auto my-4 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-950/20">
    <table class="min-w-full border-collapse">
      <thead>
        <tr class="bg-gray-100/50 dark:bg-gray-800/50">
          <th
            v-for="(header, idx) in (token as Tokens.Table).header"
            :key="idx"
            class="px-3 py-2 text-left text-[11px] font-bold text-gray-600 dark:text-gray-300 uppercase tracking-wider border-b border-gray-200 dark:border-gray-700"
            :style="{ textAlign: (token as Tokens.Table).align[idx] || 'left' }"
          >
            <MarkdownInline :text="header.text" mode="markdown" />
          </th>
        </tr>
      </thead>
      <tbody class="divide-y divide-gray-200 dark:divide-gray-700">
        <tr
          v-for="(row, rIdx) in (token as Tokens.Table).rows"
          :key="rIdx"
          class="hover:bg-gray-50/80 dark:hover:bg-gray-800/30 transition-colors"
        >
          <td
            v-for="(cell, cIdx) in row"
            :key="cIdx"
            class="px-3 py-2 text-sm text-gray-700 dark:text-gray-300 whitespace-normal leading-snug"
            :style="{ textAlign: (token as Tokens.Table).align[cIdx] || 'left' }"
          >
            <MarkdownInline :text="cell.text" mode="markdown" />
            <component
              :is="trailingInline"
              v-if="trailingInline && rIdx === (token as Tokens.Table).rows.length - 1 && cIdx === lastNonEmptyCellIdx({ row })"
            />
          </td>
        </tr>
      </tbody>
    </table>
  </div>
  <!-- Details -->
  <details v-else-if="token.type === 'details' || token.type === 'detailsInline'" class="my-4 p-2 border border-gray-200 dark:border-gray-700 rounded-lg bg-gray-50/50 dark:bg-gray-800/30">
    <summary v-if="(token as any).summary" class="cursor-pointer font-medium p-1 hover:bg-gray-100 dark:hover:bg-gray-700/50 rounded transition-colors">
      <MarkdownInline :text="(token as any).summary" mode="markdown" />
    </summary>
    <div class="mt-2 pl-4">
      <BlockMarkdownItem
        v-for="(childToken, idx) in (token as any).tokens"
        :key="idx"
        :token="childToken"
        :trailing-inline="idx === lastRenderableIdx({ tokens: (token as any).tokens }) ? trailingInline : undefined"
      />
    </div>
  </details>

  <!-- HTML -->
  <div v-else-if="token.type === 'html'" class="my-4">
    <MarkdownInline :text="(token as Tokens.HTML).text" mode="html" />
  </div>

  <!-- HR -->
  <hr v-else-if="token.type === 'hr'" class="my-8 border-t-2 border-gray-100 dark:border-gray-800" />

  <!-- BR -->
  <br v-else-if="token.type === 'br'" />

  <!-- Space (Ignore to prevent excessive spacing) -->
  <template v-else-if="token.type === 'space'"></template>

  <!-- Def (Reference definitions - ignore as they don't produce output) -->
  <template v-else-if="token.type === 'def'"></template>

  <!-- Checkbox (Ignore here as it's handled in the list item logic) -->
  <template v-else-if="(token.type as string) === 'checkbox'"></template>

  <!-- List Item (Fallback for nested tokens) -->
  <template v-else-if="token.type === 'list_item'">
    <BlockMarkdownItem
      v-for="(childToken, idx) in (token as Tokens.ListItem).tokens"
      :key="idx"
      :token="childToken"
      :trailing-inline="idx === lastRenderableIdx({ tokens: (token as Tokens.ListItem).tokens }) ? trailingInline : undefined"
    />
  </template>

  <!-- KaTeX -->
  <div v-else-if="token.type === 'blockKatex'" v-html="sanitizeHtml({ html: marked.parse(token.raw) as string })" class="my-4 overflow-x-auto"></div>
  <span v-else-if="token.type === 'katex' || token.type === 'inlineKatex'" v-html="sanitizeHtml({ html: marked.parseInline(token.raw) as string })"></span>

  <!-- Text / Inline elements (for tight lists or other inline contexts handled as blocks) -->
  <!-- Use template (no wrapper element) so MarkdownInline's own <span> is not double-wrapped -->
  <template v-else-if="token.type === 'text'">
    <MarkdownInline :text="(token as any).text" mode="markdown" />
    <component :is="trailingInline" v-if="trailingInline" />
  </template>
  <MarkdownInline
    v-else-if="token.type === 'codespan' || token.type === 'del' || token.type === 'em' || token.type === 'strong' || token.type === 'link' || token.type === 'image' || token.type === 'escape'"
    :text="token.raw"
    mode="markdown"
  />

  <!-- Fallback -->
  <div v-else class="text-red-500 text-xs p-2 border border-red-500 rounded my-2">
    Unknown token type: {{ token.type }}
  </div>
</template>
