<script setup lang="ts">
import { computed } from 'vue';
import type { Token, Tokens } from 'marked';
import CodeBlockWrapper from './CodeBlockWrapper.vue';
import MarkdownInline from './MarkdownInline.vue';
import BlockMarkdownItem from './BlockMarkdownItem.vue';

// Recursive component reference
// In Vue 3 script setup, self-reference is automatic if the filename matches.
// But we might need to be explicit if using dynamic component.
// BlockMarkdownItem is available here.

const props = defineProps<{
  token: Token;
}>();

const isCode = computed(() => props.token.type === 'code');
const isHeading = computed(() => props.token.type === 'heading');
const isParagraph = computed(() => props.token.type === 'paragraph');
const isList = computed(() => props.token.type === 'list');
const isBlockquote = computed(() => props.token.type === 'blockquote');
const isTable = computed(() => props.token.type === 'table');
const isHtml = computed(() => props.token.type === 'html');
const isHr = computed(() => props.token.type === 'hr');
const isSpace = computed(() => props.token.type === 'space');
const isCheckbox = computed(() => props.token.type === ('checkbox' as string));
const isText = computed(() => props.token.type === 'text');


defineExpose({
  __testOnly: {
    // Export internal state and logic used only for testing here. Do not reference these in production logic.
  }
});
</script>

<template>
  <!-- Code Block -->
  <CodeBlockWrapper
    v-if="isCode"
    :code="(token as Tokens.Code).text"
    :lang="(token as Tokens.Code).lang || ''"
  />

  <!-- Heading -->
  <component
    v-else-if="isHeading"
    :is="`h${(token as Tokens.Heading).depth}`"
    class="font-bold my-4 scroll-mt-20 text-gray-900 dark:text-gray-100"
    :class="{
      'text-2xl pb-2 border-b border-gray-200 dark:border-gray-700': (token as Tokens.Heading).depth === 1,
      'text-xl': (token as Tokens.Heading).depth === 2,
      'text-lg': (token as Tokens.Heading).depth >= 3
    }"
  >
    <MarkdownInline :text="(token as Tokens.Heading).text" />
  </component>

  <!-- Paragraph -->
  <p v-else-if="isParagraph" class="mb-4 last:mb-0 leading-relaxed text-gray-800 dark:text-gray-300">
    <MarkdownInline :text="(token as Tokens.Paragraph).text" />
  </p>

  <!-- Blockquote -->
  <blockquote v-else-if="isBlockquote" class="border-l-4 border-gray-300 dark:border-gray-600 pl-4 my-4 italic text-gray-600 dark:text-gray-400 bg-gray-50 dark:bg-gray-800/30 py-1 pr-2 rounded-r">
    <BlockMarkdownItem
      v-for="(childToken, idx) in (token as Tokens.Blockquote).tokens"
      :key="idx"
      :token="childToken"
    />
  </blockquote>

  <!-- List -->
  <component
    v-else-if="isList"
    :is="(token as Tokens.List).ordered ? 'ol' : 'ul'"
    class="list-inside mb-4 ml-4"
    :class="(token as Tokens.List).ordered ? 'list-decimal' : 'list-disc'"
    :start="(token as Tokens.List).start || undefined"
  >
    <li v-for="(item, idx) in (token as Tokens.List).items" :key="idx" class="mb-1 text-gray-800 dark:text-gray-300 pl-1">
      <div class="inline-block align-top w-full">
        <input v-if="item.task" type="checkbox" :checked="item.checked" disabled class="mr-2 mt-1" />

        <!-- Render children blocks -->
        <!-- List items contain block tokens (like Paragraph or Text) -->
        <!-- We wrap them in a div if there are multiple, or just render inline if it's a single Text token (tight list) -->
        <template v-if="item.tokens.length === 1 && item.tokens[0]?.type === 'text'">
          <MarkdownInline :text="(item.tokens[0] as Tokens.Text).text" />
        </template>
        <template v-else>
          <!-- If the first token is a paragraph and it's a tight list, we might want to unwrap the p tag? -->
          <!-- Marked handles loose vs tight by using Text vs Paragraph tokens. -->
          <!-- If it's Paragraph, our recursive renderer will render <p>. This is correct for loose lists. -->
          <!-- If it's Text (tight), it will hit the 'isText' case below in recursive call. -->
          <div class="inline-block w-full align-top">
            <BlockMarkdownItem
              v-for="(childToken, cIdx) in item.tokens"
              :key="cIdx"
              :token="childToken"
            />
          </div>
        </template>
      </div>
    </li>
  </component>

  <!-- Table -->
  <div v-else-if="isTable" class="overflow-x-auto my-4 rounded-lg border border-gray-200 dark:border-gray-700 shadow-sm">
    <table class="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
      <thead class="bg-gray-50 dark:bg-gray-800">
        <tr>
          <th
            v-for="(header, idx) in (token as Tokens.Table).header"
            :key="idx"
            class="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider"
            :style="{ textAlign: (token as Tokens.Table).align[idx] || 'left' }"
          >
            <MarkdownInline :text="header.text" />
          </th>
        </tr>
      </thead>
      <tbody class="bg-white dark:bg-gray-900 divide-y divide-gray-200 dark:divide-gray-800">
        <tr v-for="(row, rIdx) in (token as Tokens.Table).rows" :key="rIdx" class="hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors">
          <td
            v-for="(cell, cIdx) in row"
            :key="cIdx"
            class="px-4 py-3 text-sm text-gray-700 dark:text-gray-300 whitespace-normal"
            :style="{ textAlign: (token as Tokens.Table).align[cIdx] || 'left' }"
          >
            <MarkdownInline :text="cell.text" />
          </td>
        </tr>
      </tbody>
    </table>
  </div>

  <!-- HTML -->
  <div v-else-if="isHtml" v-html="(token as Tokens.HTML).text" class="my-4"></div>

  <!-- HR -->
  <hr v-else-if="isHr" class="my-8 border-t-2 border-gray-100 dark:border-gray-800" />

  <!-- Space (Ignore to prevent excessive spacing) -->
  <template v-else-if="isSpace"></template>

  <!-- Checkbox (Ignore here as it's handled in the list item logic) -->
  <template v-else-if="isCheckbox"></template>

  <!-- Text (for tight lists or other inline contexts handled as blocks) -->
  <span v-else-if="isText">
    <MarkdownInline :text="(token as Tokens.Text).text" />
  </span>

  <!-- Fallback -->
  <div v-else class="text-red-500 text-xs p-2 border border-red-500 rounded my-2">
    Unknown token type: {{ token.type }}
  </div>
</template>
