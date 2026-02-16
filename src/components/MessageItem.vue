<script setup lang="ts">
import { computed, ref, onMounted, nextTick, watch, onUnmounted } from 'vue';
import { Marked } from 'marked';
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
import type { MessageNode, BinaryObject, EndpointType } from '../models/types';
import { User, Bird, Brain, GitFork, Pencil, ChevronLeft, ChevronRight, Copy, Check, AlertTriangle, Download, RefreshCw, Loader2, Send, Settings2, XCircle, Square, MoreVertical, History, FileEdit } from 'lucide-vue-next';
import { storageService } from '../services/storage';
import { useGlobalEvents } from '../composables/useGlobalEvents';
import { sanitizeFilename } from '../utils/string';
// IMPORTANT: SpeechControl is used in every message and should be immediately available.
import SpeechControl from './SpeechControl.vue';
// IMPORTANT: ImageConjuringLoader is essential for showing image generation progress immediately.
import ImageConjuringLoader from './ImageConjuringLoader.vue';
import { ImageDownloadHydrator } from './ImageDownloadHydrator';
import { transformersJsService } from '../services/transformers-js';
import { defineAsyncComponentAndLoadOnMounted } from '../utils/vue';
const ImageGenerationSettings = defineAsyncComponentAndLoadOnMounted(() => import('./ImageGenerationSettings.vue'));
const MessageDiffModal = defineAsyncComponentAndLoadOnMounted(() => import('./MessageDiffModal.vue'));
const AdvancedTextEditor = defineAsyncComponentAndLoadOnMounted(() => import('./AdvancedTextEditor.vue'));
import { useImagePreview } from '../composables/useImagePreview';
import { useChat } from '../composables/useChat';
import {
  isImageGenerationPending,
  isImageGenerationProcessed,
  getImageGenerationProgress,
  stripNaidanSentinels,
  IMAGE_BLOCK_LANG,
  GeneratedImageBlockSchema,
  isImageRequest,
  parseImageRequest,
  createImageRequestMarker
} from '../utils/image-generation';

const props = defineProps<{
  chatId?: string;
  message: MessageNode;
  siblings?: MessageNode[];
  canGenerateImage?: boolean;
  isProcessing?: boolean;
  isGenerating?: boolean;
  availableImageModels?: string[];
  endpointType?: EndpointType;
}>();

const emit = defineEmits<{
  (e: 'fork', messageId: string): void;
  (e: 'edit', messageId: string, newContent: string): void;
  (e: 'switch-version', messageId: string): void;
  (e: 'regenerate', messageId: string): void;
  (e: 'abort'): void;
}>();

const isEditing = ref(false);
const isAdvancedEditorOpen = ref(false);
const editContent = ref(props.message.content.trimEnd());
const textareaRef = ref<HTMLTextAreaElement | null>(null);
const copied = ref(false);

import MessageActionsMenu from './MessageActionsMenu.vue';

const showMoreMenu = ref(false);
const showDiffModal = ref(false);
const moreActionsTriggerRef = ref<HTMLElement | null>(null);

const transformersStatus = ref(transformersJsService.getState().status);
let transformersUnsubscribe: (() => void) | null = null;

const isImageRequestMsg = computed(() => isImageRequest(props.message.content));
const editImageMode = ref(false);
const editImageParams = ref({
  width: 512,
  height: 512,
  model: undefined as string | undefined,
  count: 1,
  steps: undefined as number | undefined,
  seed: undefined as number | 'browser_random' | undefined,
  persistAs: 'original' as 'original' | 'webp' | 'jpeg' | 'png'
});

const attachmentUrls = ref<Record<string, string>>({});
const generatedImageUrls = ref<Record<string, string>>({});
const hydrationCleanups: (() => void)[] = [];
let hydrationLock = false;

const { openPreview } = useImagePreview();
const { imageProgressMap } = useChat();

function openAdvancedEditor() {
  isAdvancedEditorOpen.value = true;
}

function closeAdvancedEditor() {
  isAdvancedEditorOpen.value = false;
}

function handleAdvancedEditorUpdate({ content: newContent }: { content: string }) {
  editContent.value = newContent;
}

async function handlePreviewImage(id: string) {
  // To support next/prev navigation, we'd ideally pass all images in this chat or message.
  // For now, let's at least try to fetch metadata for the clicked one.
  const obj = await storageService.getBinaryObject({ binaryObjectId: id });
  if (obj) {
    // If it's a message attachment, we can pass all images in this message for navigation
    const allImages: BinaryObject[] = (props.message.attachments || [])
      .filter(a => a.status !== 'missing' && a.mimeType.startsWith('image/'))
      .map(a => ({ id: a.binaryObjectId, mimeType: a.mimeType, size: a.size, createdAt: a.uploadedAt, name: a.originalName }));

    // Also include generated images if they exist in this message's content
    const placeholders = messageRef.value?.querySelectorAll('.naidan-generated-image');
    if (placeholders) {
      for (const el of placeholders) {
        const hid = (el as HTMLElement).dataset.id;
        if (hid && !allImages.find(i => i.id === hid)) {
          // Fetch meta if missing
          const meta = await storageService.getBinaryObject({ binaryObjectId: hid });
          if (meta) allImages.push(meta);
        }
      }
    }

    openPreview({
      objects: allImages.length > 0 ? allImages : [obj],
      initialId: id
    });
  }
}

async function loadAttachments() {
  if (!props.message.attachments) return;

  for (const att of props.message.attachments) {
    switch (att.status) {
    case 'memory':
      attachmentUrls.value[att.id] = URL.createObjectURL(att.blob);
      break;
    case 'persisted':
      try {
        const blob = await storageService.getFile(att.binaryObjectId);
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

async function loadGeneratedImages() {
  if (hydrationLock) return;
  hydrationLock = true;

  try {
    await nextTick();
    const root = contentRef.value || messageRef.value;
    if (!root) return;

    // Cleanup previous hydrations before starting new ones
    while (hydrationCleanups.length > 0) {
      const cleanup = hydrationCleanups.pop();
      if (cleanup) cleanup();
    }

    const placeholders = Array.from(root.querySelectorAll('.naidan-generated-image'));

    for (const el of placeholders) {
      const htmlEl = el as HTMLElement;

      try {
        const ctx = await ImageDownloadHydrator.prepareContext(htmlEl, storageService);
        if (!ctx) continue;

        const { id, isSupported, width, height, prompt, steps, seed } = ctx;
        let urlObj = generatedImageUrls.value[id];

        if (!urlObj) {
          const blob = await storageService.getFile(id);
          if (blob) {
            urlObj = URL.createObjectURL(blob);
            generatedImageUrls.value[id] = urlObj;
          } else {
            throw new Error(`Image not found in storage: ${id}`);
          }
        }

        if (urlObj) {
          // Create the hydrated image element via the hydrator
          const imgEl = ImageDownloadHydrator.createImageElement({
            url: urlObj,
            width,
            height,
            onPreview: () => handlePreviewImage(id)
          });

          const skeleton = htmlEl.querySelector('.animate-pulse');
          if (skeleton) {
            skeleton.replaceWith(imgEl);
          } else {
            const existingImg = htmlEl.querySelector('img.naidan-clickable-img');
            if (existingImg instanceof HTMLImageElement) {
              existingImg.src = urlObj;
            } else {
              htmlEl.prepend(imgEl);
            }
          }

          // Hydrate the download button portal using the specialized hydrator
          const portal = htmlEl.querySelector('.naidan-download-portal');
          if (portal instanceof HTMLElement) {
            const unmount = ImageDownloadHydrator.mount({
              portal,
              isSupported,
              onDownload: ({ withMetadata }) => ImageDownloadHydrator.download({
                id, prompt, steps, seed,
                model: props.message.modelId || undefined,
                withMetadata,
                storageService,
                onError: (err) => addErrorEvent({
                  source: 'MessageItem:Download',
                  message: 'Failed to embed metadata in image.',
                  details: err instanceof Error ? err.message : String(err),
                })
              })
            });
            hydrationCleanups.push(unmount);
          }
        }
      } catch (e) {
        console.error('Failed to load generated image:', e);
        htmlEl.innerHTML = `<div class="p-3 bg-red-50 dark:bg-red-900/20 border border-red-100 dark:border-red-800 rounded-xl text-red-600 dark:text-red-400 text-xs">Failed to load generated image</div>`;
      }
    }
  } finally {
    hydrationLock = false;
  }
  await nextTick();
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
    editContent.value = stripNaidanSentinels(props.message.content).trimEnd();

    // Initialize image generation settings if it's an image request
    if (isImageRequestMsg.value) {
      editImageMode.value = true;
      const parsed = parseImageRequest(props.message.content);
      if (parsed) {
        editImageParams.value = {
          width: parsed.width ?? 512,
          height: parsed.height ?? 512,
          model: parsed.model || undefined,
          count: parsed.count ?? 1,
          steps: parsed.steps,
          seed: parsed.seed,
          persistAs: parsed.persistAs ?? 'original'
        };
      }
    } else {
      editImageMode.value = false;
    }

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
    let finalContent = editContent.value.trimEnd();
    if (editImageMode.value) {
      const marker = createImageRequestMarker({
        width: editImageParams.value.width,
        height: editImageParams.value.height,
        model: editImageParams.value.model,
        count: editImageParams.value.count,
        steps: editImageParams.value.steps,
        seed: editImageParams.value.seed,
        persistAs: editImageParams.value.persistAs
      });
      finalContent = marker + '\n' + finalContent;
    }
    emit('edit', props.message.id, finalContent);
  }
  isEditing.value = false;
}

function handleCancelEdit() {
  editContent.value = stripNaidanSentinels(props.message.content).trimEnd();
  isEditing.value = false;
}

function handleClearContent() {
  editContent.value = '';
  nextTick(() => {
    textareaRef.value?.focus();
  });
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

const { addErrorEvent } = useGlobalEvents();

const marked = new Marked();

marked.use(markedKatex({
  throwOnError: false,
  output: 'html',
}));

marked.use({
  renderer: {
    code(token) {
      const code = token.text;
      const lang = token.lang || '';

      // 1. Generated Image Block
      if (lang === IMAGE_BLOCK_LANG) {
        try {
          const result = GeneratedImageBlockSchema.safeParse(JSON.parse(code));
          if (result.success) {
            const { binaryObjectId: id, displayWidth: w, displayHeight: h, prompt: p, steps: s, seed: sd } = result.data;

            const div = document.createElement('div');
            div.className = 'naidan-generated-image my-4 relative group/gen-img w-fit rounded-xl';
            div.dataset.id = id;
            div.dataset.width = String(w);
            div.dataset.height = String(h);
            div.dataset.prompt = p || '';
            if (s !== undefined) div.dataset.steps = String(s);
            if (sd !== undefined) div.dataset.seed = String(sd);

            // Skeleton placeholder
            const skeleton = document.createElement('div');
            skeleton.className = 'flex items-center justify-center bg-gray-100 dark:bg-gray-800 animate-pulse !m-0 rounded-xl';
            skeleton.style.width = `${w}px`;
            skeleton.style.height = `${h}px`;
            skeleton.style.maxWidth = '100%';
            skeleton.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-image text-gray-400"><rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/></svg>';
            div.appendChild(skeleton);

            // Portal for Vue component (will be hydrated in loadGeneratedImages)
            const portal = document.createElement('div');
            portal.className = 'naidan-download-portal absolute top-2 right-2 z-10 opacity-0 touch-visible group-hover/gen-img:opacity-100 transition-all';
            portal.innerHTML = '<!-- hydratable -->';
            div.appendChild(portal);

            return div.outerHTML;
          } else {
            console.error('Failed to validate generated image block', result.error);
            addErrorEvent({
              source: 'MessageItem:MarkdownRenderer',
              message: 'Failed to validate generated image metadata.',
              details: result.error.message,
            });
          }
        } catch (e) {
          console.error('Failed to parse generated image block JSON', e);
          addErrorEvent({
            source: 'MessageItem:MarkdownRenderer',
            message: 'Failed to parse generated image metadata.',
            details: e instanceof Error ? e.message : String(e),
          });
        }
        return `<pre class="hljs"><code>${hljs.highlight(code, { language: 'json' }).value}</code></pre>`;
      }

      // 2. Mermaid Block
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

      // 3. Standard Code Block
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
    }
  }
});

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
  loadAttachments();

  transformersUnsubscribe = transformersJsService.subscribe((s) => {
    transformersStatus.value = s;
  });

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

    // Generated image click (preview)
    const genImg = target.closest('.naidan-clickable-img') as HTMLImageElement;
    if (genImg) {
      const block = genImg.closest('.naidan-generated-image') as HTMLElement;
      const id = block?.dataset.id;
      if (id) handlePreviewImage(id);
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

    // Generated image download button
    const gDownloadBtn = target.closest('.naidan-download-gen-image') as HTMLButtonElement;
    if (gDownloadBtn) {
      const block = gDownloadBtn.closest('.naidan-generated-image') as HTMLElement;
      const id = block?.dataset.id;
      const prompt = block?.dataset.prompt || '';
      const url = id ? generatedImageUrls.value[id] : null;

      if (url && id) {
        try {
          const obj = await storageService.getBinaryObject({ binaryObjectId: id });
          let suffix = '.png';
          if (obj?.name) {
            const lastDot = obj.name.lastIndexOf('.');
            if (lastDot !== -1) {
              suffix = obj.name.slice(lastDot);
            }
          }

          const filename = sanitizeFilename({
            base: prompt,
            suffix,
            fallback: 'generated-image',
          });

          const link = document.createElement('a');
          link.href = url;
          link.download = filename;
          document.body.appendChild(link);
          link.click();
          document.body.removeChild(link);
        } catch (err) {
          console.error('Failed to get binary object info for download:', err);
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

onUnmounted(() => {
  // Revoke all created URLs
  Object.values(attachmentUrls.value).forEach(url => URL.revokeObjectURL(url));
  Object.values(generatedImageUrls.value).forEach(url => URL.revokeObjectURL(url));

  if (transformersUnsubscribe) transformersUnsubscribe();

  // Cleanup all hydrated components
  while (hydrationCleanups.length > 0) {
    const cleanup = hydrationCleanups.pop();
    if (cleanup) cleanup();
  }
});

const messageRef = ref<HTMLElement | null>(null);
const contentRef = ref<HTMLElement | null>(null);

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

  // Remove technical comments (including image request and processed markers)
  content = stripNaidanSentinels(content);

  // Remove <think> blocks for display
  const cleanContent = content.replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, '').trim();

  // If we have any content after removing <think>, return it (even if just whitespace)
  // to signal that we are no longer in "initial loading" state.
  if (cleanContent.length > 0) return cleanContent;

  return '';
});

const isImageResponse = computed(() => isImageGenerationProcessed(props.message.content));

const speechText = computed(() => {
  if (!displayContent.value) return '';
  if (isImageResponse.value) return 'Image generated.'; // Don't read out HTML tags
  // For regular messages, strip HTML if we want to be safe, but at least handle images
  return displayContent.value.replace(/<[^>]*>/g, '');
});

const parsedContent = computed(() => {
  // Add mermaidMode as a dependency to trigger re-parse when it changes
  // This ensures the HTML is always in sync with the current mode
  void mermaidMode.value;
  const html = marked.parse(displayContent.value) as string;
  return DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true, svg: true },
    FORBID_ATTR: ['onerror', 'onclick', 'onload'], // Explicitly forbid dangerous attributes
    ADD_ATTR: ['data-id', 'data-width', 'data-height', 'data-prompt', 'data-steps', 'data-seed', 'data-testid'], // Allow hydration and test data
    // Allow blob: and data: protocols for experimental image generation
    ALLOWED_URI_REGEXP: /^(?:(?:(?:f|ht)tps?|mailto|tel|callto|cid|xmpp|blob|data):|[^a-z]|[a-z+.-]+(?:[^a-z+.-:]|$))/i,
  });
});

watch(parsedContent, () => {
  renderMermaid();
  loadGeneratedImages();
}, { immediate: true });

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


defineExpose({
  __testOnly: {
    // Export internal state and logic used only for testing here. Do not reference these in production logic.
  }
});
</script>

<template>
  <div
    v-if="!(isGenerating && (transformersStatus === 'loading' || transformersStatus === 'error') && endpointType === 'transformers_js')"
    ref="messageRef"
    class="flex flex-col gap-2 p-5 group transition-colors"
    :class="{ 'bg-gray-50/30 dark:bg-gray-800/20 border-y border-gray-100 dark:border-gray-800/50': !isUser }"
  >
    <div class="flex items-center gap-3 mb-1">
      <div class="w-8 h-8 rounded-xl flex items-center justify-center shadow-sm border border-gray-100 dark:border-gray-700 bg-white dark:bg-gray-800">
        <User v-if="isUser" class="w-4 h-4 text-gray-500" />
        <Bird v-else class="w-4 h-4 text-blue-600 dark:text-blue-400" />
      </div>
      <div class="text-[10px] font-bold text-gray-400 dark:text-gray-500 flex items-center gap-2">
        <span v-if="isUser" class="text-gray-800 dark:text-gray-200 uppercase tracking-widest">You</span>
        <template v-else>
          <span>{{ message.modelId || 'Assistant' }}</span>
          <div class="flex items-center gap-1">
            <SpeechControl v-if="!isImageResponse && !isImageGenerationPending(message.content)" :message-id="message.id" :content="speechText" />
            <button
              v-if="isGenerating"
              @click="emit('abort')"
              class="p-1 rounded-lg text-gray-400 hover:text-red-500 dark:text-gray-500 dark:hover:text-red-400 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
              title="Stop generation"
              data-testid="message-abort-button"
            >
              <Square class="w-3 h-3" />
            </button>
          </div>
        </template>
      </div>
    </div>

    <div :class="isEditing ? 'overflow-visible' : 'overflow-hidden'">
      <!-- Attachments -->
      <div v-if="message.attachments && message.attachments.length > 0" class="flex flex-wrap gap-2 mb-3">
        <div v-for="att in message.attachments" :key="att.id" class="relative group/att">
          <template v-if="att.status !== 'missing' && attachmentUrls[att.id]">
            <img
              :src="attachmentUrls[att.id]"
              @click="handlePreviewImage(att.binaryObjectId)"
              class="max-w-[300px] max-h-[300px] object-contain rounded-xl border border-gray-100 dark:border-gray-700 shadow-sm cursor-pointer hover:opacity-95 transition-opacity"
            />
            <a
              :href="attachmentUrls[att.id]"
              :download="att.originalName"
              class="absolute top-2 right-2 p-1.5 bg-white/90 dark:bg-gray-800/90 backdrop-blur-sm border border-gray-100 dark:border-gray-700 rounded-lg text-gray-500 hover:text-blue-600 dark:hover:text-blue-400 shadow-sm opacity-0 touch-visible group-hover/att:opacity-100 transition-all z-10"
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
        <div class="border border-gray-200 dark:border-gray-600 rounded-xl bg-white dark:bg-gray-800 shadow-sm focus-within:ring-2 focus-within:ring-blue-500/20 focus-within:border-blue-500 transition-all overflow-visible">
          <textarea
            ref="textareaRef"
            v-model="editContent"
            @keydown.enter.ctrl.prevent="handleSaveEdit"
            @keydown.enter.meta.prevent="handleSaveEdit"
            @keydown.esc.prevent="handleCancelEdit"
            class="w-full p-4 bg-transparent text-gray-800 dark:text-gray-100 text-sm focus:outline-none h-32 resize-none"
            data-testid="edit-textarea"
          ></textarea>

          <div class="flex items-center justify-between px-3 pb-3">
            <div class="flex items-center gap-1">
              <button
                v-if="canGenerateImage"
                @click="editImageMode = !editImageMode"
                class="p-2 rounded-xl transition-colors"
                :class="editImageMode ? 'text-blue-600 bg-blue-50 dark:bg-blue-900/20 ring-2 ring-blue-500/20' : 'text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 hover:bg-gray-50 dark:hover:bg-gray-800'"
                title="Tools"
                data-testid="toggle-edit-image-mode"
              >
                <Settings2 class="w-5 h-5" />
              </button>
              <button
                @click="openAdvancedEditor"
                class="p-2 rounded-xl text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
                title="Open Advanced Editor"
                data-testid="open-advanced-editor-button"
              >
                <FileEdit class="w-5 h-5" />
              </button>
            </div>
            <div class="flex items-center gap-2">
              <button
                v-if="editContent"
                @click="handleClearContent"
                class="flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 rounded-lg transition-colors"
                title="Clear all text"
                data-testid="clear-edit-content"
              >
                <XCircle class="w-3.5 h-3.5" />
                <span>Clear</span>
              </button>
              <button @click="handleCancelEdit" class="px-3 py-1.5 text-xs font-bold text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg transition-colors">Cancel</button>
              <button @click="handleSaveEdit" class="px-4 py-1.5 text-xs font-bold bg-blue-600 text-white rounded-xl hover:bg-blue-700 transition-all flex items-center gap-2 shadow-lg shadow-blue-500/30" data-testid="save-edit">
                <span>{{ isUser ? 'Send & Branch' : 'Update & Branch' }}</span>
                <span class="opacity-60 text-[9px] border border-white/20 px-1 rounded font-medium">{{ sendShortcutText }}</span>
              </button>
            </div>
          </div>

          <!-- Inline Experimental Tools (if active) -->
          <div v-if="editImageMode" class="border-t border-gray-100 dark:border-gray-700 bg-gray-50/50 dark:bg-gray-900/20 py-1" data-testid="embedded-experimental-tools">
            <ImageGenerationSettings
              :can-generate-image="canGenerateImage ?? false"
              :is-processing="isProcessing ?? false"
              :is-image-mode="editImageMode"
              :selected-width="editImageParams.width"
              :selected-height="editImageParams.height"
              :selected-count="editImageParams.count"
              :selected-steps="editImageParams.steps"
              :selected-seed="editImageParams.seed"
              :selected-persist-as="editImageParams.persistAs"
              :available-image-models="availableImageModels ?? []"
              :selected-image-model="editImageParams.model"
              :show-header="true"
              @toggle-image-mode="editImageMode = !editImageMode"
              @update:resolution="(w, h) => { editImageParams.width = w; editImageParams.height = h; }"
              @update:count="c => editImageParams.count = c"
              @update:steps="s => editImageParams.steps = s"
              @update:seed="s => editImageParams.seed = s"
              @update:persist-as="f => editImageParams.persistAs = f"
              @update:model="m => editImageParams.model = m"
            />
          </div>
        </div>
      </div>
      <div v-else>
        <!-- Content Display (Always shown if present) -->
        <div v-if="displayContent" ref="contentRef" class="prose prose-sm dark:prose-invert max-w-none text-gray-800 dark:text-gray-200 overflow-x-auto leading-relaxed" v-html="parsedContent" data-testid="message-content"></div>

        <!-- AI Image Synthesis Loader (Componentized) -->
        <ImageConjuringLoader
          v-if="isImageGenerationPending(message.content) && message.role === 'assistant' && !message.error"
          v-bind="getImageGenerationProgress(message.content)"
          :current-step="isGenerating && chatId ? imageProgressMap[chatId]?.currentStep : undefined"
          :total-steps="isGenerating && chatId ? imageProgressMap[chatId]?.totalSteps : undefined"
        />

        <!-- Loading State (Initial Wait for regular text) -->
        <div v-else-if="!displayContent && !hasThinking && message.role === 'assistant' && !message.error && !isImageGenerationPending(message.content)" class="py-2 flex items-center gap-2 text-gray-400" data-testid="loading-indicator">
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
            <SpeechControl v-if="!isImageResponse && !isImageGenerationPending(message.content)" :message-id="message.id" :content="speechText" show-full-controls />

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

            <!-- More Actions Menu -->
            <div class="relative">
              <button
                ref="moreActionsTriggerRef"
                @click="showMoreMenu = !showMoreMenu"
                class="p-1.5 text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
                title="More actions"
                data-testid="message-more-actions-button"
              >
                <MoreVertical class="w-3.5 h-3.5" />
              </button>

              <MessageActionsMenu
                :is-open="showMoreMenu"
                :trigger-el="moreActionsTriggerRef"
                @close="showMoreMenu = false"
              >
                <button
                  @click="showDiffModal = true; showMoreMenu = false"
                  class="w-full flex items-center gap-2.5 px-3 py-1.5 text-xs font-medium whitespace-nowrap transition-colors text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 hover:text-blue-600 dark:hover:text-blue-400"
                  data-testid="compare-versions-button"
                >
                  <History class="w-3.5 h-3.5" />
                  <span>Compare Versions</span>
                </button>
              </MessageActionsMenu>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Version History Diff Modal -->
    <MessageDiffModal
      v-if="showDiffModal"
      :is-open="showDiffModal"
      :siblings="siblings || []"
      :current-message-id="message.id"
      @close="showDiffModal = false"
      data-testid="message-diff-modal"
    />

    <Teleport to="body">
      <div v-if="isAdvancedEditorOpen" class="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-10 bg-black/50 backdrop-blur-sm">
        <div class="w-full max-w-5xl h-full max-h-[90vh]">
          <AdvancedTextEditor
            :initial-value="editContent"
            :title="undefined"
            @update:content="handleAdvancedEditorUpdate"
            @close="closeAdvancedEditor"
          />
        </div>
      </div>
    </Teleport>
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

/* Dropdown Transition */
.dropdown-enter-active,
.dropdown-leave-active {
  transition: all 0.2s ease;
}

.dropdown-enter-from,
.dropdown-leave-to {
  opacity: 0;
  transform: scale(0.95) translateY(10px);
}
</style>
