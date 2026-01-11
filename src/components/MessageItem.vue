<script setup lang="ts">
import { computed, ref, onMounted, nextTick, watch } from 'vue';
import { Marked } from 'marked';
import { markedHighlight } from 'marked-highlight';
import markedKatex from 'marked-katex-extension';
import createDOMPurify from 'dompurify';
import hljs from 'highlight.js';
import mermaid from 'mermaid';

const DOMPurify = typeof window !== 'undefined' ? createDOMPurify(window) : createDOMPurify();
import 'highlight.js/styles/github-dark.css'; 
import 'katex/dist/katex.min.css';
import type { MessageNode } from '../models/types';
import { User, Bird, Brain, GitFork, Pencil, ChevronLeft, ChevronRight, Copy, Check } from 'lucide-vue-next';

const props = defineProps<{
  message: MessageNode;
  siblings?: MessageNode[];
}>();

const emit = defineEmits<{
  (e: 'fork', messageId: string): void;
  (e: 'edit', messageId: string, newContent: string): void;
  (e: 'switch-version', messageId: string): void;
}>();

const isEditing = ref(false);
const editContent = ref(props.message.content.trimEnd());
const textareaRef = ref<HTMLTextAreaElement | null>(null);
const copied = ref(false);

type MermaidMode = 'preview' | 'code' | 'both';
const mermaidMode = ref<MermaidMode>('preview');

const isMac = typeof window !== 'undefined' && /Mac|iPod|iPhone|iPad/.test(navigator.platform);
const sendShortcutText = isMac ? 'Cmd + Enter' : 'Ctrl + Enter';

// Focus and move cursor to end when editing starts
watch(isEditing, (editing) => {
  if (editing) {
    editContent.value = props.message.content.trimEnd();
    nextTick(() => {
      if (textareaRef.value) {
        textareaRef.value.focus();
        // Move cursor to end
        textareaRef.value.selectionStart = textareaRef.value.value.length;
        textareaRef.value.selectionEnd = textareaRef.value.value.length;
      }
    });
  }
});

const versionInfo = computed(() => {
  if (!props.siblings || props.siblings.length <= 1) return null;
  const index = props.siblings.findIndex(m => m.id === props.message.id);
  return {
    current: index + 1,
    total: props.siblings.length,
    hasPrev: index > 0,
    hasNext: index < props.siblings.length - 1,
    prevId: index > 0 ? props.siblings[index - 1]?.id : null,
    nextId: index < props.siblings.length - 1 ? props.siblings[index + 1]?.id : null,
  };
});

function handleSaveEdit() {
  if (editContent.value.trim() && editContent.value !== props.message.content) {
    emit('edit', props.message.id, editContent.value);
  }
  isEditing.value = false;
}

function handleCancelEdit() {
  editContent.value = props.message.content.trimEnd();
  isEditing.value = false;
}

async function handleCopy() {
  try {
    await navigator.clipboard.writeText(props.message.content);
    copied.value = true;
    setTimeout(() => {
      copied.value = false;
    }, 2000);
  } catch (err) {
    console.error('Failed to copy text: ', err);
  }
}

const actionIcons = {
  copy: `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-copy"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>`,
  check: `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-check"><path d="M20 6 9 17l-5-5"/></svg>`,
  preview: `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-presentation"><path d="M2 3h20"/><path d="M21 3v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V3"/><path d="m7 21 5-5 5 5"/></svg>`,
  code: `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-file-code"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="m10 13-2 2 2 2"/><path d="m14 17 2-2-2-2"/></svg>`,
  both: `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-columns-2"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M12 3v18"/></svg>`,
};

function setMermaidMode(mode: MermaidMode) {
  mermaidMode.value = mode;
  if (mode !== 'code') {
    renderMermaid();
  }
}

// Initialize Mermaid
mermaid.initialize({
  startOnLoad: false,
  theme: 'dark',
});

const marked = new Marked(
  markedHighlight({
    langPrefix: 'hljs language-',
    highlight(code, lang) {
      if (lang === 'mermaid') {
        const mode = mermaidMode.value;
        const encodedCode = btoa(unescape(encodeURIComponent(code))); // Base64 to safely store in attribute
        
        return `<div class="mermaid-block relative group/mermaid" data-mermaid-mode="${mode}" data-raw="${encodedCode}">
                  <div class="mermaid-ui-overlay flex items-center gap-2">
                    <div class="mermaid-tabs">
                      <button class="mermaid-tab ${mode === 'preview' ? 'active' : ''}" data-mode="preview" title="Preview Only">
                        ${actionIcons.preview}
                        <span>Preview</span>
                      </button>
                      <button class="mermaid-tab ${mode === 'code' ? 'active' : ''}" data-mode="code" title="Code Only">
                        ${actionIcons.code}
                        <span>Code</span>
                      </button>
                      <button class="mermaid-tab ${mode === 'both' ? 'active' : ''}" data-mode="both" title="Show Both">
                        ${actionIcons.both}
                        <span>Both</span>
                      </button>
                    </div>
                    <button class="mermaid-copy-btn flex items-center gap-1.5 px-2 py-1 bg-white/90 dark:bg-gray-800/90 backdrop-blur-sm border border-gray-200 dark:border-gray-700 rounded-md shadow-sm text-[10px] font-medium text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100 transition-all cursor-pointer opacity-0 group-hover/mermaid:opacity-100" title="Copy Mermaid code">
                      ${actionIcons.copy}
                      <span>Copy</span>
                    </button>
                  </div>
                  <pre class="mermaid" style="display: ${mode === 'code' ? 'none' : 'block'}">${code}</pre>
                  <pre class="mermaid-raw hljs language-mermaid" style="display: ${mode === 'preview' ? 'none' : 'block'}"><code>${hljs.highlight(code, { language: 'plaintext' }).value}</code></pre>
                </div>`;
      }
                                    const language = hljs.getLanguage(lang) ? lang : 'plaintext';
                                    const highlighted = hljs.highlight(code, { language }).value;
                                    
                                    return `<div class="code-block-wrapper my-4 rounded-lg overflow-hidden border border-gray-700/50 bg-[#0d1117] group/code">` +
                                                              `<div class="flex items-center justify-between px-3 py-1.5 bg-gray-800/50 border-b border-gray-700/50 text-xs text-gray-400">` +
                                                                `<span class="font-mono">${language}</span>` +
                                                                `<button class="code-copy-btn flex items-center gap-1.5 hover:text-white transition-colors cursor-pointer" title="Copy code">` +
                                                                  actionIcons.copy +
                                                                  `<span>Copy</span>` +
                                                                `</button>` +
                                                              `</div>` +
                                                              `<pre class="!m-0 !p-4 !bg-transparent !rounded-b-lg overflow-x-auto"><code class="!bg-transparent !p-0 !border-none text-sm font-mono leading-relaxed text-gray-200 hljs language-${language}">${highlighted}</code></pre>` +
                                                            `</div>`;
                                              
                                  },
                              
                                      }),
);

marked.use(markedKatex({
  throwOnError: false,
  output: 'html',
}));

const renderMermaid = async () => {
  await nextTick();
  try {
    if (!messageRef.value) return;
    const nodes = messageRef.value.querySelectorAll('.mermaid');
    if (nodes.length > 0) {
      await mermaid.run({
        nodes: Array.from(nodes) as HTMLElement[],
      });
    }
  } catch (e) {
    console.error('Mermaid render error', e);
  }
};

onMounted(() => {
  renderMermaid();
  // Handle clicks via event delegation
  messageRef.value?.addEventListener('click', async (e) => {
    const target = e.target as HTMLElement;
    
    // Mermaid tabs
    const tab = target.closest('.mermaid-tab') as HTMLElement;
    if (tab) {
      const mode = tab.dataset.mode as MermaidMode;
      if (mode) setMermaidMode(mode);
      return;
    }

    // Mermaid copy button
    const mCopyBtn = target.closest('.mermaid-copy-btn') as HTMLButtonElement;
    if (mCopyBtn && !mCopyBtn.dataset.copied) {
      const block = mCopyBtn.closest('.mermaid-block') as HTMLElement;
      const rawData = block?.dataset.raw;
      if (rawData) {
        try {
          const originalCode = decodeURIComponent(escape(atob(rawData)));
          await navigator.clipboard.writeText(originalCode);
          mCopyBtn.innerHTML = actionIcons.check + '<span>Copied</span>';
          mCopyBtn.dataset.copied = 'true';
          setTimeout(() => {
            mCopyBtn.innerHTML = actionIcons.copy + '<span>Copy</span>';
            delete mCopyBtn.dataset.copied;
          }, 2000);
        } catch (err) {
          console.error('Failed to copy mermaid code:', err);
        }
      }
      return;
    }

    // Code copy button
    const copyBtn = target.closest('.code-copy-btn') as HTMLButtonElement;
    if (copyBtn && !copyBtn.dataset.copied) {
      const wrapper = copyBtn.closest('.code-block-wrapper');
      const codeEl = wrapper?.querySelector('code');
      
      if (codeEl) {
        try {
          await navigator.clipboard.writeText(codeEl.textContent || '');
          
          // Visual feedback
          copyBtn.innerHTML = actionIcons.check + '<span>Copied</span>';
          copyBtn.classList.add('!opacity-100');
          copyBtn.dataset.copied = 'true';
          
          setTimeout(() => {
            copyBtn.innerHTML = actionIcons.copy + '<span>Copy</span>';
            copyBtn.classList.remove('!opacity-100');
            delete copyBtn.dataset.copied;
          }, 2000);
        } catch (err) {
          console.error('Failed to copy code:', err);
        }
      }
    }
  });
});

watch(() => props.message.content, renderMermaid);

const messageRef = ref<HTMLElement | null>(null);

watch(mermaidMode, async () => {
  if (mermaidMode.value !== 'code') {
    await nextTick(); // Wait for parsedContent to update DOM
    renderMermaid();
  }
});

const showThinking = ref(true); // Default to true during streaming to see progress

const displayThinking = computed(() => {
  if (props.message.thinking) return props.message.thinking;
  
  // Try to extract from content if not yet processed (streaming case)
  const match = props.message.content.match(/<think>([\s\S]*?)(?:<\/think>|$)/);
  return (match && match[1]) ? match[1].trim() : '';
});

const displayContent = computed(() => {
  let content = props.message.content;
  
  // Remove <think> blocks for display
  content = content.replace(/<think>[\s\S]*?(?:<\/think>|$)/g, '').trim();
  
  return content;
});

const parsedContent = computed(() => {
  // Add mermaidMode as a dependency to trigger re-parse when it changes
  // This ensures the HTML is always in sync with the current mode
  void mermaidMode.value;
  const html = marked.parse(displayContent.value) as string;
  return DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    FORBID_ATTR: ['onerror', 'onclick', 'onload'], // Explicitly forbid dangerous attributes
  });
});

const isUser = computed(() => props.message.role === 'user');
const hasThinking = computed(() => !!props.message.thinking || props.message.content.includes('<think>'));
</script>

<template>
  <div ref="messageRef" class="flex gap-4 p-4 group" :class="{ 'bg-gray-50 dark:bg-gray-800/50': !isUser }">
    <div class="flex-shrink-0">
      <div class="w-8 h-8 rounded bg-gray-200 dark:bg-gray-700 flex items-center justify-center">
        <User v-if="isUser" class="w-5 h-5 text-gray-600 dark:text-gray-300" />
        <Bird v-else class="w-5 h-5 text-indigo-600 dark:text-indigo-400" />
      </div>
    </div>
    
    <div class="flex-1 overflow-hidden">
      <!-- Thinking Block -->
      <div v-if="hasThinking" class="mb-2" data-testid="thinking-block">
        <button 
          @click="showThinking = !showThinking"
          class="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 bg-gray-100 dark:bg-gray-700 px-2 py-1 rounded"
          data-testid="toggle-thinking"
        >
          <Brain class="w-3 h-3" />
          {{ showThinking ? 'Hide Thought Process' : 'Show Thought Process' }}
        </button>
        <div v-if="showThinking && displayThinking" class="mt-2 p-3 bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 text-sm rounded border-l-4 border-gray-300 dark:border-gray-500 font-mono whitespace-pre-wrap" data-testid="thinking-content">
          {{ displayThinking }}
        </div>
      </div>

      <!-- Content -->
      <div v-if="isEditing" class="mt-1" data-testid="edit-mode">
        <textarea 
          ref="textareaRef"
          v-model="editContent"
          @keydown.enter.ctrl.prevent="handleSaveEdit"
          @keydown.enter.meta.prevent="handleSaveEdit"
          @keydown.esc.prevent="handleCancelEdit"
          class="w-full border dark:border-gray-600 rounded-lg p-3 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 h-32"
          data-testid="edit-textarea"
        ></textarea>
        <div class="flex justify-end gap-2 mt-2">
          <button @click="handleCancelEdit" class="px-3 py-1.5 text-xs text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-700 rounded transition-colors">Cancel</button>
          <button @click="handleSaveEdit" class="px-3 py-1.5 text-xs bg-indigo-600 text-white rounded hover:bg-indigo-700 transition-colors flex items-center gap-2" data-testid="save-edit">
            <span>Send & Branch</span>
            <span class="opacity-60 text-[10px] border border-white/20 px-1 rounded">{{ sendShortcutText }}</span>
          </button>
        </div>
      </div>
      <div v-else>
        <div v-if="displayContent" class="prose prose-sm dark:prose-invert max-w-none text-gray-800 dark:text-gray-200 overflow-x-auto" v-html="parsedContent" data-testid="message-content"></div>
        
        <div class="mt-2 flex items-center justify-between min-h-[28px]">
          <!-- Version Paging -->
          <div v-if="versionInfo" class="flex items-center gap-2 text-[10px] font-bold text-gray-400 uppercase tracking-widest select-none" data-testid="version-paging">
            <button 
              @click="versionInfo.prevId && emit('switch-version', versionInfo.prevId)"
              :disabled="!versionInfo.hasPrev"
              class="p-1 hover:text-indigo-500 disabled:opacity-20 transition-colors"
            >
              <ChevronLeft class="w-3 h-3" />
            </button>
            <span class="min-w-[3rem] text-center">{{ versionInfo.current }} / {{ versionInfo.total }}</span>
            <button 
              @click="versionInfo.nextId && emit('switch-version', versionInfo.nextId)"
              :disabled="!versionInfo.hasNext"
              class="p-1 hover:text-indigo-500 disabled:opacity-20 transition-colors"
            >
              <ChevronRight class="w-3 h-3" />
            </button>
          </div>
          <div v-else></div>

          <!-- Message Actions -->
          <div class="flex items-center gap-1">
            <button 
              @click="handleCopy"
              class="p-1 text-gray-400 hover:text-indigo-600 dark:hover:text-indigo-400 rounded transition-colors"
              :title="copied ? 'Copied!' : 'Copy message'"
              data-testid="copy-message-button"
            >
              <Check v-if="copied" class="w-3.5 h-3.5" />
              <Copy v-else class="w-3.5 h-3.5" />
            </button>
            <button 
              @click="isEditing = true"
              class="p-1 text-gray-400 hover:text-indigo-600 dark:hover:text-indigo-400 rounded transition-colors"
              title="Edit message"
              data-testid="edit-message-button"
            >
              <Pencil class="w-3.5 h-3.5" />
            </button>
            <button 
              @click="emit('fork', message.id)"
              class="flex items-center gap-1.5 px-2 py-1 text-gray-400 hover:text-indigo-600 dark:hover:text-indigo-400 hover:bg-indigo-50 dark:hover:bg-indigo-900/20 rounded-md transition-all"
              title="Create a new chat branching from this message"
            >
              <span class="text-[10px] font-bold uppercase tracking-tight hidden lg:inline">Fork</span>
              <GitFork class="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
