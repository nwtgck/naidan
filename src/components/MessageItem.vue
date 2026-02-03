<script setup lang="ts">
import { computed, ref, onMounted, nextTick, watch } from 'vue';
import { Marked } from 'marked';
import { markedHighlight } from 'marked-highlight';
import markedKatex from 'marked-katex-extension';
import createDOMPurify from 'dompurify';
import hljs from 'highlight.js';
import mermaid from 'mermaid';

const DOMPurify = (() => {
  const t = typeof window;
  switch (t) {
  case 'undefined': return createDOMPurify();
  case 'object':
  case 'boolean':
  case 'string':
  case 'number':
  case 'function':
  case 'symbol':
  case 'bigint':
    return createDOMPurify(window);
  default: {
    const _ex: never = t;
    return _ex;
  }
  }
})();
import 'highlight.js/styles/github-dark.css'; 
import 'katex/dist/katex.min.css';
import type { MessageNode } from '../models/types';
import { User, Bird, Brain, GitFork, Pencil, ChevronLeft, ChevronRight, Copy, Check, AlertTriangle, Download, RefreshCw, Loader2, Send } from 'lucide-vue-next';
import { storageService } from '../services/storage';
import SpeechControl from './SpeechControl.vue';

const props = defineProps<{
  message: MessageNode;
  siblings?: MessageNode[];
}>();

const emit = defineEmits<{
  (e: 'fork', messageId: string): void;
  (e: 'edit', messageId: string, newContent: string): void;
  (e: 'switch-version', messageId: string): void;
  (e: 'regenerate', messageId: string): void;
}>();

const isEditing = ref(false);
const editContent = ref(props.message.content.trimEnd());
const textareaRef = ref<HTMLTextAreaElement | null>(null);
const copied = ref(false);

const attachmentUrls = ref<Record<string, string>>({});

async function loadAttachments() {
  if (!props.message.attachments) return;

  for (const att of props.message.attachments) {
    switch (att.status) {
    case 'memory':
      attachmentUrls.value[att.id] = URL.createObjectURL(att.blob);
      break;
    case 'persisted':
      try {
        const blob = await storageService.getFile(att.id, att.originalName);
        if (blob) {
          attachmentUrls.value[att.id] = URL.createObjectURL(blob);
        }
      } catch (e) {
        console.error('Failed to load persisted attachment:', e);
      }
      break;
    case 'missing':
      break;
    default: {
      const _ex: never = att;
      throw new Error(`Unhandled attachment status: ${_ex}`);
    }
    }
  }
}

type MermaidMode = 'preview' | 'code' | 'both';
const mermaidMode = ref<MermaidMode>('preview');

const isMac = (() => {
  const t = typeof window;
  switch (t) {
  case 'undefined': return false;
  case 'object':
  case 'boolean':
  case 'string':
  case 'number':
  case 'function':
  case 'symbol':
  case 'bigint':
    return /Mac|iPod|iPhone|iPad/.test(navigator.platform);
  default: {
    const _ex: never = t;
    return _ex;
  }
  }
})();
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
  if (editContent.value.trim()) {
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
  switch (mode) {
  case 'preview':
  case 'both':
    renderMermaid();
    break;
  case 'code':
    break;
  default: {
    const _ex: never = mode;
    throw new Error(`Unhandled mermaid mode: ${_ex}`);
  }
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
                      <button class="mermaid-tab ${(() => {
    switch (mode) {
    case 'preview': return 'active';
    case 'code':
    case 'both': return '';
    default: { const _ex: never = mode; return _ex; }
    }
  })()}" data-mode="preview" title="Preview Only">
                        ${actionIcons.preview}
                        <span>Preview</span>
                      </button>
                      <button class="mermaid-tab ${(() => {
    switch (mode) {
    case 'code': return 'active';
    case 'preview':
    case 'both': return '';
    default: { const _ex: never = mode; return _ex; }
    }
  })()}" data-mode="code" title="Code Only">
                        ${actionIcons.code}
                        <span>Code</span>
                      </button>
                      <button class="mermaid-tab ${(() => {
    switch (mode) {
    case 'both': return 'active';
    case 'preview':
    case 'code': return '';
    default: { const _ex: never = mode; return _ex; }
    }
  })()}" data-mode="both" title="Show Both">
                        ${actionIcons.both}
                        <span>Both</span>
                      </button>
                    </div>
                    <button class="mermaid-copy-btn flex items-center gap-1.5 px-2 py-1 bg-white/90 dark:bg-gray-800/90 backdrop-blur-sm border border-gray-200 dark:border-gray-700 rounded-md shadow-sm text-[10px] font-medium text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100 transition-all cursor-pointer opacity-0 group-hover/mermaid:opacity-100" title="Copy Mermaid code">
                      ${actionIcons.copy}
                      <span>Copy</span>
                    </button>
                  </div>
                  <pre class="mermaid" style="display: ${(() => {
    switch (mode) {
    case 'code': return 'none';
    case 'preview':
    case 'both': return 'block';
    default: { const _ex: never = mode; return _ex; }
    }
  })()}">${code}</pre>
                  <pre class="mermaid-raw hljs language-mermaid" style="display: ${(() => {
    switch (mode) {
    case 'preview': return 'none';
    case 'code':
    case 'both': return 'block';
    default: { const _ex: never = mode; return _ex; }
    }
  })()}"><code>${hljs.highlight(code, { language: 'plaintext' }).value}</code></pre>
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
  loadAttachments();
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

import { onUnmounted } from 'vue';

onUnmounted(() => {
  // Revoke all created URLs
  Object.values(attachmentUrls.value).forEach(url => URL.revokeObjectURL(url));
});

watch(() => props.message.content, renderMermaid);

const messageRef = ref<HTMLElement | null>(null);

watch(mermaidMode, async () => {
  switch (mermaidMode.value) {
  case 'preview':
  case 'both':
    await nextTick(); // Wait for parsedContent to update DOM
    renderMermaid();
    break;
  case 'code':
    break;
  default: {
    const _ex: never = mermaidMode.value;
    throw new Error(`Unhandled mermaid mode: ${_ex}`);
  }
  }
});

const showThinking = ref(false); // Default to collapsed

const displayThinking = computed(() => {
  if (props.message.thinking) return props.message.thinking;
  
  // Try to extract from content if not yet processed (streaming case)
  const matches = [...props.message.content.matchAll(/<think>([\s\S]*?)(?:<\/think>|$)/gi)];
  if (matches.length === 0) return '';
  
  return matches.map(m => m[1]?.trim()).filter(Boolean).join('\n\n---\n\n');
});

const displayContent = computed(() => {
  let content = props.message.content;
  
  // Remove <think> blocks for display
  const cleanContent = content.replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, '');
  
  // If we have any content after removing <think>, return it (even if just whitespace)
  // to signal that we are no longer in "initial loading" state.
  if (cleanContent.length > 0) return cleanContent;
  
  return '';
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

const isUser = computed(() => {
  switch (props.message.role) {
  case 'user': return true;
  case 'assistant':
  case 'system':
    return false;
  default: {
    const _ex: never = props.message.role;
    return _ex;
  }
  }
});
const hasThinking = computed(() => !!props.message.thinking || /<think>/i.test(props.message.content));
const isThinkingNow = computed(() => {
  if (props.message.thinking) return false; // Already processed
  const content = props.message.content;
  const lastOpen = content.lastIndexOf('<think>');
  const lastClose = content.lastIndexOf('</think>');
  return lastOpen > -1 && lastClose < lastOpen;
});

function formatSize(bytes?: number): string {
  if (bytes === undefined) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let size = bytes;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex++;
  }
  return `${size.toFixed(1)} ${units[unitIndex]}`;
}

function handleToggleThinking() {
  if (typeof window !== 'undefined' && window.getSelection()?.toString()) return;
  showThinking.value = !showThinking.value;
}
</script>

<template>
  <div ref="messageRef" class="flex flex-col gap-2 p-5 group transition-colors" :class="{ 'bg-gray-50/30 dark:bg-gray-800/20 border-y border-gray-100 dark:border-gray-800/50': !isUser }">
    <div class="flex items-center gap-3 mb-1">
      <div class="w-8 h-8 rounded-xl flex items-center justify-center shadow-sm border border-gray-100 dark:border-gray-700 bg-white dark:bg-gray-800">
        <User v-if="isUser" class="w-4 h-4 text-gray-500" />
        <Bird v-else class="w-4 h-4 text-blue-600 dark:text-blue-400" />
      </div>
      <div class="text-[10px] font-bold text-gray-400 dark:text-gray-500 flex items-center gap-2">
        <span v-if="isUser" class="text-gray-800 dark:text-gray-200 uppercase tracking-widest">You</span>
        <template v-else>
          <span>{{ message.modelId || 'Assistant' }}</span>
          <SpeechControl :message-id="message.id" :content="message.content" />
        </template>
      </div>
    </div>
    
    <div class="overflow-hidden">
      <!-- Attachments -->
      <div v-if="message.attachments && message.attachments.length > 0" class="flex flex-wrap gap-2 mb-3">
        <div v-for="att in message.attachments" :key="att.id" class="relative group/att">
          <template v-if="att.status !== 'missing' && attachmentUrls[att.id]">
            <img 
              :src="attachmentUrls[att.id]" 
              class="max-w-[300px] max-h-[300px] object-contain rounded-xl border border-gray-100 dark:border-gray-700 shadow-sm"
            />
            <a 
              :href="attachmentUrls[att.id]" 
              :download="att.originalName"
              class="absolute top-2 right-2 p-1.5 bg-white/90 dark:bg-gray-800/90 backdrop-blur-sm border border-gray-100 dark:border-gray-700 rounded-lg text-gray-500 hover:text-blue-600 dark:hover:text-blue-400 shadow-sm opacity-0 group-hover/att:opacity-100 transition-all z-10"
              title="Download image"
              data-testid="download-attachment"
            >
              <Download class="w-4 h-4" />
            </a>
          </template>
          <template v-else>
            <div class="flex items-center gap-2 px-3 py-2 bg-gray-50 dark:bg-gray-800 rounded-xl border border-gray-100 dark:border-gray-700 text-xs text-gray-500">
              <AlertTriangle class="w-3.5 h-3.5 text-amber-500" />
              <span>Image missing ({{ att.originalName }}) - {{ formatSize(att.size) }}</span>
            </div>
          </template>
        </div>
      </div>

      <!-- Thinking Block -->
      <div v-if="hasThinking" class="mb-3" data-testid="thinking-block">
        <div 
          class="transition-all duration-300 ease-in-out relative group/thinking"
          :class="[
            /* Shape & Size */
            showThinking ? 'w-full p-5 rounded-2xl' : 'inline-flex items-center w-auto px-3 py-1.5 rounded-xl cursor-pointer',
            
            /* State: Active Thinking */
            /* We remove 'border' and 'shadow' from parent when thinking to avoid artifacts. 
               The child div handles the border/glow. */
            isThinkingNow 
              ? 'overflow-visible' 
              : 'border shadow-sm overflow-hidden',

            /* Background & Colors (Normal State) */
            !isThinkingNow && showThinking 
              ? 'bg-gradient-to-br from-blue-50/50 to-sky-50/50 dark:from-blue-950/20 dark:to-sky-950/20 border-blue-100/50 dark:border-blue-800/30 shadow-inner' 
              : '',
            !isThinkingNow && !showThinking 
              ? 'bg-white dark:bg-gray-800/50 border-blue-100/50 dark:border-blue-800/30 hover:border-blue-200 dark:hover:border-blue-800' 
              : '',

            /* Background (Thinking State) - No borders here, handled by CSS */
            isThinkingNow && showThinking 
              ? 'bg-gradient-to-br from-blue-50/50 to-sky-50/50 dark:from-blue-950/20 dark:to-sky-950/20 shadow-inner' 
              : '',
            isThinkingNow && !showThinking 
              ? 'bg-white dark:bg-gray-800/50' 
              : ''
          ]"
          @click="handleToggleThinking"
          data-testid="toggle-thinking"
        >
          <!-- Dedicated Thinking Border Element -->
          <!-- Using style="border-radius: inherit" ensures we perfectly match the parent's rounded-xl/2xl state -->
          <div 
            v-if="isThinkingNow" 
            class="absolute inset-0 pointer-events-none thinking-gradient-border"
            style="border-radius: inherit;"
          ></div>

          <!-- Header / Button Content -->
          <div 
            class="flex items-center gap-2 text-[10px] font-bold uppercase tracking-wider relative z-20 transition-colors"
            :class="[
              showThinking ? 'mb-3 text-blue-600 dark:text-blue-400' : 'text-gray-500 dark:text-gray-400 group-hover/thinking:text-blue-600',
              isThinkingNow ? 'animate-pulse text-blue-700 dark:text-blue-400' : ''
            ]"
          >
            <Brain class="w-3.5 h-3.5" />
            <span v-if="isThinkingNow">Thinking...</span>
            <span v-else>{{ showThinking ? 'Hide Thought Process' : 'Show Thought Process' }}</span>
          </div>

          <!-- Expanded Content -->
          <div 
            v-if="showThinking && displayThinking" 
            class="relative z-20 text-gray-600 dark:text-gray-400 text-[11px] font-mono whitespace-pre-wrap leading-relaxed animate-in fade-in slide-in-from-top-1 duration-200" 
            data-testid="thinking-content"
          >
            <!-- Brain watermark -->
            <div class="absolute top-0 right-0 opacity-[0.03] dark:opacity-[0.07] pointer-events-none -mt-8">
              <Brain class="w-16 h-16" />
            </div>
            {{ displayThinking }}
          </div>
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
          class="w-full border border-gray-200 dark:border-gray-600 rounded-xl p-4 bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-100 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 h-32 shadow-sm transition-all"
          data-testid="edit-textarea"
        ></textarea>
        <div class="flex justify-end gap-2 mt-2">
          <button @click="handleCancelEdit" class="px-4 py-1.5 text-xs font-bold text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-xl transition-colors">Cancel</button>
          <button @click="handleSaveEdit" class="px-4 py-1.5 text-xs font-bold bg-blue-600 text-white rounded-xl hover:bg-blue-700 transition-all flex items-center gap-2 shadow-lg shadow-blue-500/30" data-testid="save-edit">
            <span>{{ isUser ? 'Send & Branch' : 'Update & Branch' }}</span>
            <span class="opacity-60 text-[9px] border border-white/20 px-1 rounded font-medium">{{ sendShortcutText }}</span>
          </button>
        </div>
      </div>
      <div v-else>
        <!-- Content Display (Always shown if present) -->
        <div v-if="displayContent" class="prose prose-sm dark:prose-invert max-w-none text-gray-800 dark:text-gray-200 overflow-x-auto leading-relaxed" v-html="parsedContent" data-testid="message-content"></div>

        <!-- Loading State (Initial Wait) -->
        <div v-if="!displayContent && !hasThinking && message.role === 'assistant' && !message.error" class="py-2 flex items-center gap-2 text-gray-400" data-testid="loading-indicator">
          <Loader2 class="w-4 h-4 animate-spin" />
          <span class="text-xs font-medium">Waiting for response...</span>
        </div>

        <!-- Error State (Appended below content) -->
        <div v-if="message.error" class="mt-2 p-3 bg-red-50 dark:bg-red-900/20 border border-red-100 dark:border-red-800 rounded-xl text-red-600 dark:text-red-400 text-sm flex flex-col gap-2 items-start" data-testid="error-message">
          <div class="flex items-center gap-2 font-bold">
            <AlertTriangle class="w-4 h-4" />
            <span>Generation Failed</span>
          </div>
          <div class="opacity-90">{{ message.error }}</div>
          <button 
            @click="emit('regenerate', message.id)"
            class="mt-1 px-3 py-1.5 bg-white dark:bg-gray-800 border border-red-200 dark:border-red-700 hover:bg-red-50 dark:hover:bg-red-900/30 text-red-600 dark:text-red-400 rounded-lg text-xs font-bold transition-colors flex items-center gap-2"
            data-testid="retry-button"
          >
            <RefreshCw class="w-3.5 h-3.5" />
            <span>Retry</span>
          </button>
        </div>
        
        <div class="mt-3 flex items-center justify-between min-h-[28px]">
          <!-- Version Paging -->
          <div v-if="versionInfo" class="flex items-center gap-2 text-[10px] font-bold text-gray-400 uppercase tracking-widest bg-gray-50 dark:bg-gray-800 px-2 py-0.5 rounded-lg border border-gray-100 dark:border-gray-700" data-testid="version-paging">
            <button 
              @click="versionInfo.prevId && emit('switch-version', versionInfo.prevId)"
              :disabled="!versionInfo.hasPrev"
              class="p-1 hover:text-blue-600 disabled:opacity-20 transition-colors"
            >
              <ChevronLeft class="w-3 h-3" />
            </button>
            <span class="min-w-[2.5rem] text-center">{{ versionInfo.current }} / {{ versionInfo.total }}</span>
            <button 
              @click="versionInfo.nextId && emit('switch-version', versionInfo.nextId)"
              :disabled="!versionInfo.hasNext"
              class="p-1 hover:text-blue-600 disabled:opacity-20 transition-colors"
            >
              <ChevronRight class="w-3 h-3" />
            </button>
          </div>
          <div v-else></div>

          <!-- Message Actions -->
          <div class="flex items-center gap-1">
            <!-- Speech Controls -->
            <SpeechControl :message-id="message.id" :content="message.content" show-full-controls />

            <button 
              v-if="!isUser"
              @click="emit('regenerate', message.id)"
              class="p-1.5 text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
              title="Regenerate response"
              data-testid="regenerate-button"
            >
              <RefreshCw class="w-3.5 h-3.5" />
            </button>
            <button 
              v-if="isUser"
              @click="emit('edit', message.id, message.content)"
              class="p-1.5 text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
              title="Resend message"
              data-testid="resend-button"
            >
              <Send class="w-3.5 h-3.5" />
            </button>
            <button 
              @click="handleCopy"
              class="p-1.5 text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
              :title="copied ? 'Copied!' : 'Copy message'"
              data-testid="copy-message-button"
            >
              <Check v-if="copied" class="w-3.5 h-3.5" />
              <Copy v-else class="w-3.5 h-3.5" />
            </button>
            <button 
              @click="isEditing = true"
              class="p-1.5 text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
              title="Edit message"
              data-testid="edit-message-button"
            >
              <Pencil class="w-3.5 h-3.5" />
            </button>
            <button 
              @click="emit('fork', message.id)"
              class="flex items-center gap-1.5 px-3 py-1 text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/20 rounded-lg transition-all"
              title="Create a new chat branching from this message"
            >
              <span class="text-[10px] font-bold uppercase tracking-widest hidden lg:inline">Fork</span>
              <GitFork class="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
@property --thinking-angle {
  syntax: '<angle>';
  initial-value: 0deg;
  inherits: false;
}

@keyframes thinking-sweep {
  0% {
    --thinking-angle: 0deg;
    opacity: 0;
  }
  2% {
    opacity: 1;
  }
  35% {
    --thinking-angle: 360deg;
    opacity: 1;
  }
  40% {
    opacity: 0;
  }
  100% {
    --thinking-angle: 360deg;
    opacity: 0;
  }
}

.thinking-gradient-border {
  /* Line thickness defined by padding */
  padding: 1.2px;
  
  /* Glow effect applied to this element (which matches the parent's shape via border-radius: inherit) */
  box-shadow: 0 0 20px -5px rgba(59, 130, 246, 0.4);

  /* Rotating gradient background */
  background: conic-gradient(
    from var(--thinking-angle),
    #3b82f6 0%,
    #8b5cf6 10%,
    #06b6d4 20%,
    transparent 40%,
    transparent 100%
  );

  /* MASKING: Cut out the content box, leaving only the padding area (border) */
  -webkit-mask: 
    linear-gradient(#fff 0 0) content-box, 
    linear-gradient(#fff 0 0);
  -webkit-mask-composite: xor;
  
  mask: 
    linear-gradient(#fff 0 0) content-box, 
    linear-gradient(#fff 0 0);
  mask-composite: exclude;

  /* Animation */
  animation: thinking-sweep 0.9s linear infinite;
  
  /* Sit behind content (z-10/20) but above parent background if transparent */
  z-index: 10;
}
</style>
