<script setup lang="ts">
import { computed, ref, onMounted, nextTick, watch, onUnmounted, provide } from 'vue';
import BlockMarkdownRenderer from './block-markdown/BlockMarkdownRenderer.vue';
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
import type { MessageNode, BinaryObject, EndpointType, LmParameters, Reasoning } from '../models/types';
import { EMPTY_LM_PARAMETERS } from '../models/types';
import { User, Bird, ChevronLeft, ChevronRight, AlertTriangle, Download, RefreshCw, Loader2, Settings2, XCircle, Square, FileEdit, MoreHorizontal, Brain } from 'lucide-vue-next';
import { storageService } from '../services/storage';
import { useGlobalEvents } from '../composables/useGlobalEvents';
import { sanitizeFilename } from '../utils/string';
// IMPORTANT: SpeechControl is used in every message and should be immediately available.
import SpeechControl from './SpeechControl.vue';
// IMPORTANT: ImageConjuringLoader is essential for showing image generation progress immediately.
import ImageConjuringLoader from './ImageConjuringLoader.vue';
import { ImageDownloadHydrator } from './ImageDownloadHydrator';
import ImageIndexBadge from './ImageIndexBadge.vue';
import MessageThinking from './MessageThinking.vue';
import MessageActions from './MessageActions.vue';
import SpeechLanguageSelector from './SpeechLanguageSelector.vue';
import { transformersJsService } from '../services/transformers-js';
import { defineAsyncComponentAndLoadOnMounted } from '../utils/vue';
const ImageGenerationSettings = defineAsyncComponentAndLoadOnMounted(() => import('./ImageGenerationSettings.vue'));
const ReasoningSettings = defineAsyncComponentAndLoadOnMounted(() => import('./ReasoningSettings.vue'));
const MessageDiffModal = defineAsyncComponentAndLoadOnMounted(() => import('./MessageDiffModal.vue'));
const AdvancedTextEditor = defineAsyncComponentAndLoadOnMounted(() => import('./AdvancedTextEditorV3.vue'));
import { useImagePreview, MESSAGE_CONTEXTUAL_PREVIEW_KEY } from '../composables/useImagePreview';
import { useChat } from '../composables/useChat';
import { useReasoning } from '../composables/useReasoning';
import { useLayout } from '../composables/useLayout';
import { useSettings } from '../composables/useSettings';
import {
  isImageGenerationPending,
  isImageGenerationProcessed,
  getImageGenerationProgress,
  stripNaidanSentinels,
  IMAGE_BLOCK_LANG,
  GeneratedImageBlockSchema,
  isImageRequest,
  parseImageRequest,
  createImageRequestMarker,
  getDisplayDimensions,
  getImageStats
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
  (e: 'edit', messageId: string, newContent: string, lmParameters: LmParameters | undefined): void;
  (e: 'switch-version', messageId: string): void;
  (e: 'regenerate', messageId: string): void;
  (e: 'abort'): void;
}>();

const isEditing = ref(false);
const isAdvancedEditorOpen = ref(false);
const showExtensions = ref(false);
const editContent = ref(props.message.content.trimEnd());
const textareaRef = ref<HTMLTextAreaElement | null>(null);

const showDiffModal = ref(false);

const transformersStatus = ref(transformersJsService.getState().status);
let transformersUnsubscribe: (() => void) | null = null;

const isImageRequestMsg = computed(() => isImageRequest(props.message.content));
const showImageSettings = ref(false);
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
let pendingHydration = false;

// Cache for metadata support to avoid redundant file reads
const metadataSupportCache = new Map<string, boolean>();

const { openPreview } = useImagePreview();
const { imageProgressMap, currentChat } = useChat();
const { getReasoningEffort } = useReasoning();
const { preferredEditorMode, setPreferredEditorMode } = useLayout();
const { settings } = useSettings();

const editReasoningEffort = ref<Reasoning['effort']>(undefined);

function openAdvancedEditor() {
  isAdvancedEditorOpen.value = true;
}

function closeAdvancedEditor() {
  isAdvancedEditorOpen.value = false;
}

function handleAdvancedEditorUpdate({ content: newContent }: { content: string }) {
  editContent.value = newContent;
}

function handleAdvancedEditorModeUpdate({ mode }: { mode: 'advanced' | 'textarea' }) {
  setPreferredEditorMode({ mode });
}

async function handlePreviewImage({ id }: { id: string }) {
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

provide(MESSAGE_CONTEXTUAL_PREVIEW_KEY, handlePreviewImage);

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
  if (hydrationLock) {
    pendingHydration = true;
    return;
  }
  hydrationLock = true;
  pendingHydration = false;

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

    // Parallelize hydration to improve performance, especially with multiple images
    await Promise.all(placeholders.map(async (el, idx) => {
      const htmlEl = el as HTMLElement;

      try {
        const id = htmlEl.dataset.id;
        if (!id) return;

        // Use cached support status if available to avoid redundant file reads
        let isSupported = metadataSupportCache.get(id);

        const displayWidth = htmlEl.dataset.displayWidth;
        const displayHeight = htmlEl.dataset.displayHeight;
        const width = htmlEl.dataset.width;
        const height = htmlEl.dataset.height;
        const prompt = htmlEl.dataset.prompt || '';
        const steps = htmlEl.dataset.steps ? parseInt(htmlEl.dataset.steps) : undefined;
        const seed = htmlEl.dataset.seed ? parseInt(htmlEl.dataset.seed) : undefined;

        let urlObj = generatedImageUrls.value[id];
        let blob: Blob | undefined;

        if (!urlObj) {
          const fetchedBlob = await storageService.getFile(id);
          if (fetchedBlob) {
            blob = fetchedBlob;
            urlObj = URL.createObjectURL(blob);
            generatedImageUrls.value[id] = urlObj;
          } else {
            throw new Error(`Image not found in storage: ${id}`);
          }
        }

        // If support status not cached, we need to prepare context once
        if (isSupported === undefined) {
          const ctx = await ImageDownloadHydrator.prepareContext(htmlEl, storageService, blob);
          if (ctx) {
            isSupported = ctx.isSupported;
            metadataSupportCache.set(id, isSupported);
          }
        }

        if (urlObj) {
          // Create the hydrated image element via the hydrator
          const imgEl = ImageDownloadHydrator.createImageElement({
            url: urlObj,
            width: displayWidth,
            height: displayHeight,
            onPreview: () => handlePreviewImage({ id })
          });

          const skeleton = htmlEl.querySelector('.naidan-image-skeleton');
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

          // Hydrate the download button portal
          const dlPortal = htmlEl.querySelector('.naidan-download-portal');
          const widthVal = displayWidth ? parseInt(displayWidth) : 0;
          if (dlPortal instanceof HTMLElement) {
            const unmount = ImageDownloadHydrator.mount({
              portal: dlPortal,
              isSupported: isSupported ?? false,
              align: widthVal < 300 ? 'left' : 'right',
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

          // Hydrate the info display portal
          const infoPortal = htmlEl.querySelector('.naidan-info-portal');
          if (infoPortal instanceof HTMLElement) {
            const unmountInfo = ImageDownloadHydrator.mountInfo({
              portal: infoPortal,
              prompt,
              steps,
              seed,
              width,
              height,
              align: 'left' // Info is on the left, so always grow right
            });
            hydrationCleanups.push(unmountInfo);
          }

          // Hydrate the badge portal
          const badgePortal = htmlEl.querySelector('.naidan-badge-portal');
          const hasMultipleImages = (imageStats.value.totalCount !== undefined && imageStats.value.totalCount > 1) ||
                                   (imageStats.value.totalCount === undefined && imageStats.value.generatedCount > 1);

          if (badgePortal instanceof HTMLElement && hasMultipleImages) {
            const unmountBadge = ImageDownloadHydrator.mountBadge({
              portal: badgePortal,
              index: idx + 1,
              total: imageStats.value.totalCount
            });
            hydrationCleanups.push(unmountBadge);
          }
        }
      } catch (e) {
        console.error('Failed to load generated image:', e);
        htmlEl.innerHTML = `<div class="p-3 bg-red-50 dark:bg-red-900/20 border border-red-100 dark:border-red-800 rounded-xl text-red-600 dark:text-red-400 text-xs">Failed to load generated image</div>`;
      }
    }));
  } finally {
    hydrationLock = false;
    if (pendingHydration) {
      loadGeneratedImages();
    }
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

    // Initialize reasoning effort from message if available, otherwise from current chat
    if (props.message.role === 'user' && props.message.lmParameters?.reasoning) {
      editReasoningEffort.value = props.message.lmParameters.reasoning.effort;
    } else if (currentChat.value) {
      editReasoningEffort.value = getReasoningEffort({ chatId: currentChat.value.id });
    }

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

    // Auto-open tools if either image mode or non-default reasoning is active
    showImageSettings.value = editImageMode.value || editReasoningEffort.value !== undefined;

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
    const lmParameters: LmParameters = {
      ...(settings.value.lmParameters || EMPTY_LM_PARAMETERS),
      stop: settings.value.lmParameters?.stop ? [...settings.value.lmParameters.stop] : undefined,
      reasoning: { effort: editReasoningEffort.value }
    };
    emit('edit', props.message.id, finalContent, lmParameters);
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
            const { binaryObjectId: id, prompt: p, steps: s, seed: sd } = result.data;
            const { width: dw, height: dh } = getDisplayDimensions({
              width: result.data.width,
              height: result.data.height,
              displayWidth: result.data.displayWidth,
              displayHeight: result.data.displayHeight
            });

            const div = document.createElement('div');
            div.className = 'naidan-generated-image my-4 relative group/gen-img w-fit rounded-xl overflow-visible';
            div.dataset.id = id;
            div.dataset.displayWidth = String(dw);
            div.dataset.displayHeight = String(dh);
            if (result.data.width !== undefined) div.dataset.width = String(result.data.width);
            if (result.data.height !== undefined) div.dataset.height = String(result.data.height);
            div.dataset.prompt = p || '';
            if (s !== undefined) div.dataset.steps = String(s);
            if (sd !== undefined) div.dataset.seed = String(sd);

            // Skeleton placeholder
            const skeleton = document.createElement('div');
            skeleton.className = 'naidan-image-skeleton flex items-center justify-center bg-gray-100 dark:bg-gray-800 animate-pulse !m-0 rounded-xl';
            skeleton.style.width = `${dw}px`;
            skeleton.style.maxWidth = '100%';
            skeleton.style.aspectRatio = `${dw} / ${dh}`;
            skeleton.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-image text-gray-400"><rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/></svg>';
            div.appendChild(skeleton);

            // Portals for Vue components (will be hydrated in loadGeneratedImages)
            const dlPortal = document.createElement('div');
            dlPortal.className = 'naidan-download-portal absolute top-2 right-2 z-30 opacity-0 touch-visible group-hover/gen-img:opacity-100 transition-all overflow-visible';
            dlPortal.innerHTML = '<!-- hydratable -->';
            div.appendChild(dlPortal);

            const infoPortal = document.createElement('div');
            infoPortal.className = 'naidan-info-portal absolute top-2 left-2 z-30 opacity-0 touch-visible group-hover/gen-img:opacity-100 transition-all overflow-visible';
            infoPortal.innerHTML = '<!-- hydratable -->';
            div.appendChild(infoPortal);

            const badgePortal = document.createElement('div');
            badgePortal.className = 'naidan-badge-portal absolute bottom-2 left-2 z-10';
            badgePortal.innerHTML = '<!-- hydratable -->';
            div.appendChild(badgePortal);

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
      if (id) handlePreviewImage({ id });
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

const imageStats = computed(() => getImageStats(props.message.content));

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

const isUser = computed((): boolean => {
  const node = props.message;
  switch (node.role) {
  case 'user': return true;
  case 'assistant':
  case 'system':
    return false;
  default: {
    const _ex: never = node;
    return (_ex as { role: string }).role === 'user';
  }
  }
});

const reasoningEffortLabel = computed(() => {
  const effort = (() => {
    switch (props.message.role) {
    case 'assistant':
      return props.message.lmParameters?.reasoning?.effort;
    case 'user':
    case 'system':
      return undefined;
    default: {
      const _ex: never = props.message;
      throw new Error(`Unhandled role: ${(_ex as { role: string }).role}`);
    }
    }
  })();

  if (effort === undefined) return undefined;

  switch (effort) {
  case 'none':
    return 'Off';
  case 'low':
  case 'medium':
  case 'high':
    return 'Think';
  default: {
    const _ex: never = effort;
    return _ex;
  }
  }
});

const reasoningEffortTooltip = computed(() => {
  const effort = (() => {
    switch (props.message.role) {
    case 'assistant':
      return props.message.lmParameters?.reasoning?.effort;
    case 'user':
    case 'system':
      return undefined;
    default: {
      const _ex: never = props.message;
      throw new Error(`Unhandled role: ${(_ex as { role: string }).role}`);
    }
    }
  })();

  if (effort === undefined) return undefined;

  switch (effort) {
  case 'none':
    return 'Think: Disabled';
  case 'low':
  case 'medium':
  case 'high': {
    const label = effort.charAt(0).toUpperCase() + effort.slice(1);
    return `Think: ${label} Effort\n(Note: Specific effort levels may be ignored by some models)`;
  }
  default: {
    const _ex: never = effort;
    return _ex;
  }
  }
});

const hasThinking = computed(() => !!props.message.thinking || /<think>/i.test(props.message.content));

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

defineExpose({
  __testOnly: {
    openAdvancedEditor,
    handleAdvancedEditorModeUpdate,
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
          <div
            v-if="reasoningEffortLabel"
            class="flex items-center gap-1 ml-1 text-[8px] font-mono text-gray-400 dark:text-gray-500 leading-none cursor-help"
            :title="reasoningEffortTooltip"
            data-testid="reasoning-effort-badge"
          >
            <Brain class="w-2.5 h-2.5" />
            <span>{{ reasoningEffortLabel }}</span>
          </div>
          <div class="flex items-center gap-1 group/msg-header-tools">
            <SpeechControl v-if="!isImageResponse && !isImageGenerationPending(message.content)" :message-id="message.id" :content="speechText" :is-generating="isGenerating" />

            <!-- Header Extensions Slot (Seamless transition) -->
            <div v-if="showExtensions" class="flex items-center gap-1 mx-1 animate-in slide-in-from-left-1 fade-in duration-200">
              <SpeechLanguageSelector :message-id="message.id" :content="speechText" is-mini align="down" />
              <!-- Future tools here -->
            </div>

            <button
              v-if="isGenerating"
              @click="emit('abort')"
              class="p-1 rounded-lg text-gray-400 hover:text-red-500 dark:text-gray-500 dark:hover:text-red-400 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
              title="Stop generation"
              data-testid="message-abort-button"
            >
              <Square class="w-3 h-3" />
            </button>

            <!-- Generic More Button (Absolute Right Anchor for Header) -->
            <button
              v-if="!isImageResponse && !isImageGenerationPending(message.content)"
              @click="showExtensions = !showExtensions"
              class="p-1 rounded-lg transition-colors"
              :class="showExtensions ? 'text-blue-600 bg-blue-50 dark:bg-blue-900/20' : 'text-gray-400 hover:text-gray-600 dark:hover:text-gray-300'"
              title="More Message Tools"
            >
              <MoreHorizontal class="w-3.5 h-3.5" />
            </button>
          </div>
        </template>
      </div>
    </div>

    <div :class="isEditing ? 'overflow-visible' : 'overflow-hidden'">
      <!-- Attachments -->
      <div v-if="message.attachments && message.attachments.length > 0" class="flex flex-wrap gap-2 mb-3">
        <div v-for="(att, idx) in message.attachments" :key="att.id" class="relative group/att">
          <template v-if="att.status !== 'missing' && attachmentUrls[att.id]">
            <img
              :src="attachmentUrls[att.id]"
              @click="handlePreviewImage({ id: att.binaryObjectId })"
              class="max-w-[300px] max-h-[300px] object-contain rounded-xl border border-gray-100 dark:border-gray-700 shadow-sm cursor-pointer hover:opacity-95 transition-opacity"
            />
            <div v-if="message.attachments.length > 1" class="absolute bottom-2 left-2 z-10">
              <ImageIndexBadge :index="idx + 1" :total="message.attachments.length" />
            </div>
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

      <MessageThinking :message="message" />

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
                v-if="canGenerateImage || true"
                @click="showImageSettings = !showImageSettings"
                class="p-2 rounded-xl transition-colors"
                :class="showImageSettings || editImageMode || editReasoningEffort !== undefined ? 'text-blue-600 bg-blue-50 dark:bg-blue-900/20 ring-2 ring-blue-500/20' : 'text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 hover:bg-gray-50 dark:hover:bg-gray-800'"
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
          <div v-if="showImageSettings" class="border-t border-gray-100 dark:border-gray-700 bg-gray-50/50 dark:bg-gray-900/20 py-1" data-testid="embedded-experimental-tools">
            <div class="px-3 py-1.5 text-[10px] font-bold text-gray-400 uppercase tracking-widest border-b dark:border-gray-700 mb-1">
              Options/Tools
            </div>
            <ReasoningSettings
              :selected-effort="editReasoningEffort"
              @update:effort="e => editReasoningEffort = e"
            />
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
        <template v-if="displayContent">
          <BlockMarkdownRenderer
            v-if="!settings.experimental || settings.experimental.markdownRendering === 'block_markdown'"
            :content="displayContent"
          />
          <div
            v-else
            ref="contentRef"
            class="prose prose-sm dark:prose-invert max-w-none text-gray-800 dark:text-gray-200 overflow-x-auto leading-relaxed"
            v-html="parsedContent"
            data-testid="message-content"
          ></div>
        </template>

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
          <div v-if="versionInfo" class="message-version-paging flex items-center gap-2 text-[10px] font-bold text-gray-400 uppercase tracking-widest bg-gray-50 dark:bg-gray-800 px-2 py-0.5 rounded-lg border border-gray-100 dark:border-gray-700" data-testid="version-paging">
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
          <MessageActions
            :message="message"
            :is-image-response="isImageResponse"
            :is-user="isUser"
            :is-generating="isGenerating"
            v-model:show-extensions="showExtensions"
            :speech-text="speechText"
            :display-content="displayContent"
            @regenerate="id => emit('regenerate', id)"
            @edit="(id, content, params) => emit('edit', id, content, params)"
            @fork="id => emit('fork', id)"
            @enter-edit-mode="isEditing = true"
            @show-diff="showDiffModal = true"
          />

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
            :mode="preferredEditorMode"
            @update:content="handleAdvancedEditorUpdate"
            @update:mode="handleAdvancedEditorModeUpdate"
            @close="closeAdvancedEditor"
          />
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
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
