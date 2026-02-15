<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed, watch } from 'vue';
import CustomDialog from './CustomDialog.vue';
import {
  Check, RotateCw, FlipHorizontal, FlipVertical,
  RotateCcw, RefreshCcw, Undo2, Redo2,
  Crop as CropIcon, Eraser, Square, Circle,
  Link, Link2Off, PanelRight, ZoomIn, ZoomOut,
  Pipette
} from 'lucide-vue-next';

interface ImageEditorProps {
  imageUrl: string;
  fileName: string;
  originalMimeType: string;
}

const props = defineProps<ImageEditorProps>();

const emit = defineEmits<{
  (e: 'save', payload: { blob: Blob }): void;
  (e: 'cancel'): void;
}>();

const TRANSPARENT = Symbol('transparent');
type FillColor = string | symbol;

// Canvas Refs
const containerRef = ref<HTMLDivElement | undefined>(undefined);
const canvasRef = ref<HTMLCanvasElement | undefined>(undefined);

// Zoom and Panning State
const zoom = ref(1);
const panOffset = ref({ x: 0, y: 0 });
const isPanning = ref(false);
const lastMousePos = ref({ x: 0, y: 0 });

// Editor State
type EditorMode = 'idle' | 'creating' | 'moving' | 'resizing';
const editorMode = ref<EditorMode>('idle');

const isSidebarOpen = ref(true);
const showCloseConfirm = ref(false);

interface SelectionState {
  rect: { x: number; y: number; w: number; h: number };
  status: 'none' | 'active';
  shape: 'rectangle' | 'ellipse';
}

const selection = ref<SelectionState>({
  rect: { x: 0, y: 0, w: 0, h: 0 },
  status: 'none',
  shape: 'rectangle',
});

function handleClose() {
  if (hasChanges.value) {
    showCloseConfirm.value = true;
  } else {
    emit('cancel');
  }
}

function confirmClose() {
  showCloseConfirm.value = false;
  emit('cancel');
}

type OutputFormat = 'original' | 'image/png' | 'image/jpeg' | 'image/webp';
const selectedFormat = ref<OutputFormat>('image/png');

type AspectRatioLock = 'locked' | 'free';
const resizeLock = ref<AspectRatioLock>('locked');

// Mask/Crop Actions
type ActionType = 'crop' | 'mask-outside' | 'mask-inside';

const selectedFill = ref<FillColor>(TRANSPARENT);
const isPickingColor = ref(false);
const colorHistory = ref<FillColor[]>([]);

function addToHistory({ color }: { color: FillColor }) {
  if (color === TRANSPARENT) return;
  const index = colorHistory.value.indexOf(color);
  if (index !== -1) {
    colorHistory.value.splice(index, 1);
  }
  colorHistory.value.unshift(color);
  if (colorHistory.value.length > 10) {
    colorHistory.value.pop();
  }
}

watch(selectedFill, (newColor) => {
  addToHistory({ color: newColor });
});

// Geometry
const displayScale = ref(1);

// History Management
interface HistoryEntry {
  imageData: ImageData;
  selection: SelectionState;
}
const history = ref<HistoryEntry[]>([]);
const historyIndex = ref(-1);

const canUndo = computed(() => historyIndex.value > 0);
const canRedo = computed(() => historyIndex.value < history.value.length - 1);

/**
 * GEMINI.md: Named arguments logic for change detection
 */
const hasChanges = computed(() => {
  const isPixelChanged = historyIndex.value > 0;
  const isFormatChanged = selectedFormat.value !== 'original' && selectedFormat.value !== props.originalMimeType;
  return isPixelChanged || isFormatChanged;
});

// Resize inputs
const resizeW = ref<number>(0);
const resizeH = ref<number>(0);
const currentCanvasAspect = ref(1);

/**
 * Initialize editor by loading the image onto canvas
 */
async function initEditor() {
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.src = props.imageUrl;
  await new Promise((resolve) => {
    img.onload = resolve;
  });

  if (!canvasRef.value) return;
  const canvas = canvasRef.value;
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;

  updateResizeInputs({ w: canvas.width, h: canvas.height });

  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return;
  ctx.drawImage(img, 0, 0);

  // Initial history state
  const initialImageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  history.value = [{
    imageData: initialImageData,
    selection: JSON.parse(JSON.stringify(selection.value)) // Deep copy
  }];
  historyIndex.value = 0;

  zoom.value = 1;
  panOffset.value = { x: 0, y: 0 };
  updateDisplayLayout();
}

/**
 * Handle Zoom with Mouse Wheel
 */
function handleWheel(e: WheelEvent) {
  e.preventDefault();
  const zoomFactor = 1.1;
  const delta = -e.deltaY;
  const oldZoom = zoom.value;
  const newZoom = delta > 0 ? oldZoom * zoomFactor : oldZoom / zoomFactor;
  const clampedZoom = Math.min(Math.max(newZoom, 0.1), 10);

  if (clampedZoom === oldZoom) return;

  if (!containerRef.value) return;
  const rect = containerRef.value.getBoundingClientRect();
  const mouseX = e.clientX - rect.left;
  const mouseY = e.clientY - rect.top;

  const relativeX = mouseX - rect.width / 2 - panOffset.value.x;
  const relativeY = mouseY - rect.height / 2 - panOffset.value.y;

  const ratio = clampedZoom / oldZoom;
  panOffset.value = {
    x: mouseX - rect.width / 2 - relativeX * ratio,
    y: mouseY - rect.height / 2 - relativeY * ratio
  };

  zoom.value = clampedZoom;

  if (zoom.value <= 1) {
    panOffset.value = { x: 0, y: 0 };
  }
}

function startPanning(e: MouseEvent) {
  // Pan with middle click or if space/alt is pressed (detected by checking e.button === 1 or modifiers)
  if (e.button === 1 || (e.button === 0 && (e.altKey || e.shiftKey))) {
    e.preventDefault();
    isPanning.value = true;
    lastMousePos.value = { x: e.clientX, y: e.clientY };
    window.addEventListener('mousemove', onPanning);
    window.addEventListener('mouseup', stopPanning);
    return true;
  }
  return false;
}

function onPanning(e: MouseEvent) {
  if (!isPanning.value) return;
  const dx = e.clientX - lastMousePos.value.x;
  const dy = e.clientY - lastMousePos.value.y;
  panOffset.value = {
    x: panOffset.value.x + dx,
    y: panOffset.value.y + dy
  };
  lastMousePos.value = { x: e.clientX, y: e.clientY };
}

function stopPanning() {
  isPanning.value = false;
  window.removeEventListener('mousemove', onPanning);
  window.removeEventListener('mouseup', stopPanning);
}

function updateResizeInputs({ w, h }: { w: number; h: number }) {
  resizeW.value = w;
  resizeH.value = h;
  currentCanvasAspect.value = w / h;
}

/**
 * Sync resize inputs when lock is active
 */
watch(resizeW, (newW) => {
  if (resizeLock.value === 'locked' && canvasRef.value) {
    const targetH = Math.round(newW / currentCanvasAspect.value);
    if (resizeH.value !== targetH) {
      resizeH.value = targetH;
    }
  }
});

watch(resizeH, (newH) => {
  if (resizeLock.value === 'locked' && canvasRef.value) {
    const targetW = Math.round(newH * currentCanvasAspect.value);
    if (resizeW.value !== targetW) {
      resizeW.value = targetW;
    }
  }
});

/**
 * Calculate display scale to fit canvas in container
 */
function updateDisplayLayout() {
  if (!containerRef.value || !canvasRef.value) return;
  const container = containerRef.value;
  const canvas = canvasRef.value;

  const padding = 40;
  const availW = container.clientWidth - padding * 2;
  const availH = container.clientHeight - padding * 2;

  displayScale.value = Math.min(availW / canvas.width, availH / canvas.height);
}

/**
 * Commit current canvas state to history
 */
function commitHistory() {
  if (!canvasRef.value) return;
  const ctx = canvasRef.value.getContext('2d', { willReadFrequently: true });
  if (!ctx) return;

  const imageData = ctx.getImageData(0, 0, canvasRef.value.width, canvasRef.value.height);

  if (historyIndex.value < history.value.length - 1) {
    history.value = history.value.slice(0, historyIndex.value + 1);
  }

  history.value.push({
    imageData,
    selection: JSON.parse(JSON.stringify(selection.value))
  });
  historyIndex.value++;

  updateResizeInputs({ w: canvasRef.value.width, h: canvasRef.value.height });
  updateDisplayLayout();
}

function undo() {
  if (!canUndo.value) return;
  historyIndex.value--;
  restoreFromHistory();
}

function redo() {
  if (!canRedo.value) return;
  historyIndex.value++;
  restoreFromHistory();
}

function restoreFromHistory() {
  const entry = history.value[historyIndex.value];
  if (!entry || !canvasRef.value) return;

  const { imageData, selection: storedSelection } = entry;
  const canvas = canvasRef.value;
  canvas.width = imageData.width;
  canvas.height = imageData.height;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.putImageData(imageData, 0, 0);
  }

  // Restore selection
  selection.value = JSON.parse(JSON.stringify(storedSelection));

  updateResizeInputs({ w: canvas.width, h: canvas.height });
  updateDisplayLayout();
}

/**
 * Execute transformation (Rotate/Flip)
 */
async function applyTransform({ type }: { type: 'rotate-l' | 'rotate-r' | 'flip-h' | 'flip-v' }) {
  if (!canvasRef.value) return;
  const canvas = canvasRef.value;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const currentW = canvas.width;
  const currentH = canvas.height;

  const temp = document.createElement('canvas');
  temp.width = currentW;
  temp.height = currentH;
  temp.getContext('2d')?.drawImage(canvas, 0, 0);

  switch (type) {
  case 'rotate-l':
  case 'rotate-r': {
    const angle = (() => {
      switch (type) {
      case 'rotate-r': return 90;
      case 'rotate-l': return -90;
      default: {
        const _ex: never = type;
        throw new Error(`Unhandled rotate type: ${_ex}`);
      }
      }
    })();
    canvas.width = currentH;
    canvas.height = currentW;
    ctx.translate(canvas.width / 2, canvas.height / 2);
    ctx.rotate(angle * Math.PI / 180);
    ctx.drawImage(temp, -currentW / 2, -currentH / 2);
    break;
  }
  case 'flip-h': {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.scale(-1, 1);
    ctx.drawImage(temp, -currentW, 0);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    break;
  }
  case 'flip-v': {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.scale(1, -1);
    ctx.drawImage(temp, 0, -currentH);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    break;
  }
  default: {
    const _ex: never = type;
    throw new Error(`Unhandled transform: ${_ex}`);
  }
  }

  commitHistory();
}

/**
 * Execute Resize
 */
function applyResize() {
  if (!canvasRef.value || resizeW.value <= 0 || resizeH.value <= 0) return;
  const canvas = canvasRef.value;

  const temp = document.createElement('canvas');
  temp.width = canvas.width;
  temp.height = canvas.height;
  temp.getContext('2d')?.drawImage(canvas, 0, 0);

  canvas.width = resizeW.value;
  canvas.height = resizeH.value;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.drawImage(temp, 0, 0, temp.width, temp.height, 0, 0, canvas.width, canvas.height);
  }
  commitHistory();
}

/**
 * Execute Crop or Mask Action
 */
function executeAction({ action }: { action: ActionType }) {
  if (!canvasRef.value) return;
  const canvas = canvasRef.value;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  // Before performing action, ensure the *previous* state in history remembers
  // the selection that was just used. This allows Undo to restore it.
  const currentEntry = history.value[historyIndex.value];
  if (currentEntry) {
    currentEntry.selection = JSON.parse(JSON.stringify(selection.value));
  }

  const sx = selection.value.rect.x * canvas.width;
  const sy = selection.value.rect.y * canvas.height;
  const sw = selection.value.rect.w * canvas.width;
  const sh = selection.value.rect.h * canvas.height;

  const shape = selection.value.shape;

  /**
   * Helper to create path based on current shape
   */
  const createSelectionPath = (context: CanvasRenderingContext2D, x: number, y: number, w: number, h: number) => {
    context.beginPath();
    switch (shape) {
    case 'rectangle':
      context.rect(x, y, w, h);
      break;
    case 'ellipse':
      context.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
      break;
    default: {
      const _ex: never = shape;
      throw new Error(`Unhandled shape: ${_ex}`);
    }
    }
  };

  switch (action) {
  case 'crop': {
    const data = ctx.getImageData(sx, sy, sw, sh);
    canvas.width = sw;
    canvas.height = sh;
    ctx.putImageData(data, 0, 0);

    // If elliptical crop, we need to mask out the exterior of the ellipse on the new canvas
    switch (shape) {
    case 'ellipse':
      ctx.globalCompositeOperation = 'destination-in';
      ctx.fillStyle = 'black'; // Opaque brush for destination-in
      ctx.beginPath();
      ctx.ellipse(sw / 2, sh / 2, sw / 2, sh / 2, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalCompositeOperation = 'source-over';
      break;
    case 'rectangle':
      break; // No extra masking needed for rectangle crop
    default: {
      const _ex: never = shape;
      throw new Error(`Unhandled shape: ${_ex}`);
    }
    }
    break;
  }
  case 'mask-outside':
  case 'mask-inside': {
    const fillColor = selectedFill.value;
    ctx.fillStyle = (() => {
      if (fillColor === TRANSPARENT) return 'black'; // Opaque for destination-out
      return fillColor as string;
    })();

    const isTransparent = fillColor === TRANSPARENT;

    switch (action) {
    case 'mask-inside':
      if (isTransparent) ctx.globalCompositeOperation = 'destination-out';
      createSelectionPath(ctx, sx, sy, sw, sh);
      ctx.fill();
      break;
    case 'mask-outside': {
      // mask-outside
      const temp = document.createElement('canvas');
      temp.width = canvas.width;
      temp.height = canvas.height;
      const tctx = temp.getContext('2d');
      if (tctx) {
        // Fill the whole area with the color
        tctx.fillStyle = ctx.fillStyle;
        tctx.fillRect(0, 0, canvas.width, canvas.height);
        // "Punch a hole" for the selection
        tctx.globalCompositeOperation = 'destination-out';
        createSelectionPath(tctx, sx, sy, sw, sh);
        tctx.fill();

        // Draw the mask onto the main canvas
        if (isTransparent) ctx.globalCompositeOperation = 'destination-out';
        ctx.drawImage(temp, 0, 0);
      }
      break;
    }
    default: {
      const _ex: never = action;
      throw new Error(`Unhandled action: ${_ex}`);
    }
    }

    ctx.globalCompositeOperation = 'source-over';
    break;
  }
  default: {
    const _ex: never = action;
    throw new Error(`Unhandled action: ${_ex}`);
  }
  }

  // Clear selection status after action
  selection.value.status = 'none';
  commitHistory();
}


function pickColor({ event }: { event: MouseEvent }) {
  if (!canvasRef.value) return;
  const canvas = canvasRef.value;
  const rect = canvas.getBoundingClientRect();

  const x = Math.floor(((event.clientX - rect.left) / rect.width) * canvas.width);
  const y = Math.floor(((event.clientY - rect.top) / rect.height) * canvas.height);

  if (x < 0 || x >= canvas.width || y < 0 || y >= canvas.height) return;

  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return;

  const pixel = ctx.getImageData(x, y, 1, 1).data;
  const [r = 0, g = 0, b = 0, a = 0] = pixel;

  if (a === 0) {
    selectedFill.value = TRANSPARENT;
  } else {
    const toHex = (v: number) => v.toString(16).padStart(2, '0');
    selectedFill.value = `#${toHex(r)}${toHex(g)}${toHex(b)}`;
  }
  isPickingColor.value = false;
}

/**
 * Final save
 */
async function performSave() {
  if (!canvasRef.value) return;
  const format = selectedFormat.value;
  const mimeType = (() => {
    switch (format) {
    case 'original': return props.originalMimeType;
    case 'image/png':
    case 'image/jpeg':
    case 'image/webp': return format;
    default: {
      const _ex: never = format;
      throw new Error(`Unhandled format: ${_ex}`);
    }
    }
  })();

  canvasRef.value.toBlob((blob) => {
    if (blob) emit('save', { blob });
  }, mimeType);
}

// Drag logic
const dragStart = ref({ x: 0, y: 0 });
const initialCrop = ref({ x: 0, y: 0, w: 0, h: 0 });
const activeHandle = ref<string | undefined>(undefined);

function startNewSelection({ event }: { event: MouseEvent }) {
  if (isPickingColor.value) {
    pickColor({ event });
    return;
  }
  if (startPanning(event)) return;

  event.preventDefault();
  if (!canvasRef.value) return;

  const rect = canvasRef.value.getBoundingClientRect();
  const x = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
  const y = Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height));

  editorMode.value = 'creating';
  selection.value.status = 'active';
  dragStart.value = { x: event.clientX, y: event.clientY };
  selection.value.rect = { x, y, w: 0, h: 0 };
  initialCrop.value = { ...selection.value.rect };

  window.addEventListener('mousemove', onMouseMove);
  window.addEventListener('mouseup', onMouseUp);
}

function startDragging({ event, handle }: { event: MouseEvent; handle: string }) {
  event.preventDefault();

  editorMode.value = handle === 'center' ? 'moving' : 'resizing';
  activeHandle.value = handle;
  dragStart.value = { x: event.clientX, y: event.clientY };
  initialCrop.value = { ...selection.value.rect };

  window.addEventListener('mousemove', onMouseMove);
  window.addEventListener('mouseup', onMouseUp);
}

function onMouseMove(e: MouseEvent) {
  if (editorMode.value === 'idle' || !canvasRef.value) return;

  const totalScale = displayScale.value * zoom.value;
  const dx = (e.clientX - dragStart.value.x) / (canvasRef.value.width * totalScale);
  const dy = (e.clientY - dragStart.value.y) / (canvasRef.value.height * totalScale);

  let { x, y, w, h } = initialCrop.value;

  const mode = editorMode.value;
  switch (mode) {
  case 'creating':
    if (dx >= 0) {
      w = Math.min(1 - x, dx);
    } else {
      const nx = Math.max(0, x + dx);
      w = x - nx;
      x = nx;
    }

    if (dy >= 0) {
      h = Math.min(1 - y, dy);
    } else {
      const ny = Math.max(0, y + dy);
      h = y - ny;
      y = ny;
    }
    break;
  case 'moving':
    if (activeHandle.value === 'center') {
      x = Math.max(0, Math.min(1 - w, x + dx));
      y = Math.max(0, Math.min(1 - h, y + dy));
    }
    break;
  case 'resizing':
    if (activeHandle.value) {
      if (activeHandle.value.includes('e')) w = Math.max(0.01, Math.min(1 - x, w + dx));
      if (activeHandle.value.includes('w')) {
        const maxX = x + w - 0.01;
        const nx = Math.max(0, Math.min(maxX, x + dx));
        w = w - (nx - x);
        x = nx;
      }
      if (activeHandle.value.includes('s')) h = Math.max(0.01, Math.min(1 - y, h + dy));
      if (activeHandle.value.includes('n')) {
        const maxY = y + h - 0.01;
        const ny = Math.max(0, Math.min(maxY, y + dy));
        h = h - (ny - y);
        y = ny;
      }
    }
    break;
  default: {
    const _ex: never = mode;
    throw new Error(`Unhandled editor mode: ${_ex}`);
  }
  }
  selection.value.rect = { x, y, w, h };
}

function onMouseUp() {
  const mode = editorMode.value;
  switch (mode) {
  case 'creating':
    if (selection.value.rect.w < 0.005 || selection.value.rect.h < 0.005) {
      selection.value.status = 'none';
    }
    break;
  case 'moving':
  case 'resizing':
  case 'idle':
    break;
  default: {
    const _ex: never = mode;
    throw new Error(`Unhandled editor mode: ${_ex}`);
  }
  }

  editorMode.value = 'idle';
  activeHandle.value = undefined;
  window.removeEventListener('mousemove', onMouseMove);
  window.removeEventListener('mouseup', onMouseUp);
}

onMounted(() => {
  initEditor();
  window.addEventListener('resize', updateDisplayLayout);
});

onUnmounted(() => {
  window.removeEventListener('resize', updateDisplayLayout);
});

const cropBoxStyle = computed(() => {
  if (!canvasRef.value) return {};
  return {
    left: `${selection.value.rect.x * 100}%`,
    top: `${selection.value.rect.y * 100}%`,
    width: `${selection.value.rect.w * 100}%`,
    height: `${selection.value.rect.h * 100}%`,
  };
});

defineExpose({
  __testOnly: {
    history,
    historyIndex,
    undo,
    redo,
    applyTransform,
    applyResize,
    executeAction,
    selectedFill,
    colorHistory,
    isPickingColor,
    TRANSPARENT,
    resizeW,
    resizeH,
    selection,
    resizeLock,
    hasChanges,
    isSidebarOpen,
    zoom,
    panOffset,
    showCloseConfirm
  }
});
</script>

<template>
  <div class="fixed inset-0 z-[100] bg-black/95 flex flex-col p-2 sm:p-4 animate-in fade-in duration-200 text-white">
    <!-- Header -->
    <div class="w-full flex items-center justify-between mb-3 px-2">
      <div class="flex items-center gap-3">
        <div class="p-1.5 bg-blue-600 rounded-lg">
          <CropIcon class="w-4 h-4 text-white" />
        </div>
        <div class="hidden sm:block">
          <h2 class="font-bold text-sm">Image Editor</h2>
          <p class="text-gray-400 text-[10px] truncate max-w-[200px]">{{ fileName }}</p>
        </div>
      </div>

      <!-- Center: Undo/Redo -->
      <div class="flex items-center gap-1 bg-gray-800 p-1 rounded-xl border border-gray-700">
        <button
          @click="undo"
          :disabled="!canUndo"
          class="p-2 disabled:opacity-30 hover:bg-gray-700 rounded-lg transition-colors"
          title="Undo"
        >
          <Undo2 class="w-4 h-4" />
        </button>
        <button
          @click="redo"
          :disabled="!canRedo"
          class="p-2 disabled:opacity-30 hover:bg-gray-700 rounded-lg transition-colors"
          title="Redo"
        >
          <Redo2 class="w-4 h-4" />
        </button>
      </div>

      <!-- Right: Actions -->
      <div class="flex items-center gap-2">
        <button
          @click="isSidebarOpen = !isSidebarOpen"
          class="p-2 text-gray-400 hover:text-white hover:bg-white/10 rounded-xl transition-colors"
          :class="{ 'text-blue-500 bg-blue-500/10': isSidebarOpen }"
          title="Toggle Tools Sidebar"
        >
          <PanelRight class="w-5 h-5" />
        </button>
        <div class="w-px h-6 bg-gray-800 mx-1"></div>
        <button
          @click="handleClose"
          class="px-4 py-2 text-sm font-bold text-gray-400 hover:text-white transition-colors"
        >
          Close
        </button>
        <button
          @click="performSave"
          :disabled="!hasChanges"
          data-testid="image-editor-finish-button"
          class="px-6 py-2 bg-blue-600 text-white text-sm font-bold rounded-xl hover:bg-blue-700 disabled:opacity-30 disabled:cursor-not-allowed transition-all shadow-xl shadow-blue-500/30 flex items-center gap-2"
        >
          <Check class="w-4 h-4" />
          <span>Finish</span>
        </button>
      </div>
    </div>

    <!-- Main Content Area -->
    <div class="flex-1 flex gap-0 overflow-hidden relative">
      <!-- Workspace -->
      <div
        ref="containerRef"
        data-testid="image-editor-container"
        class="flex-1 relative bg-gray-900 rounded-2xl overflow-hidden shadow-2xl border border-gray-800 flex items-center justify-center select-none transition-all duration-300"
        :class="isPickingColor ? 'cursor-pointer' : 'cursor-crosshair'"
        @mousedown="startNewSelection({ event: $event })"
        @wheel="handleWheel"
      >
        <div
          class="relative border border-white/10 bg-transparency-grid transition-transform duration-75 ease-out"
          :style="{
            width: canvasRef ? `${canvasRef.width * displayScale}px` : '0px',
            height: canvasRef ? `${canvasRef.height * displayScale}px` : '0px',
            transform: `translate(${panOffset.x}px, ${panOffset.y}px) scale(${zoom})`,
          }"
        >
          <canvas ref="canvasRef" class="w-full h-full object-contain pointer-events-none"></canvas>

          <!-- Selection Rect -->
          <div
            v-if="selection.status === 'active'"
            data-testid="image-editor-selection"
            class="absolute border-2 border-blue-500 shadow-[0_0_0_9999px_rgba(0,0,0,0.5)] cursor-move group"
            :class="selection.shape === 'ellipse' ? 'rounded-full' : ''"
            :style="cropBoxStyle"
            @mousedown.stop="startDragging({ event: $event, handle: 'center' })"
          >
            <div
              v-if="selection.shape === 'rectangle'"
              class="absolute inset-0 grid grid-cols-3 grid-rows-3 pointer-events-none opacity-30"
            >
              <div v-for="i in 9" :key="i" class="border-[0.5px] border-white/50"></div>
            </div>
            <!-- Handles -->
            <div class="absolute -top-1 -left-1 w-3 h-3 bg-blue-500 rounded-full cursor-nw-resize" @mousedown.stop="startDragging({ event: $event, handle: 'nw' })"></div>
            <div class="absolute -top-1 -right-1 w-3 h-3 bg-blue-500 rounded-full cursor-ne-resize" @mousedown.stop="startDragging({ event: $event, handle: 'ne' })"></div>
            <div class="absolute -bottom-1 -left-1 w-3 h-3 bg-blue-500 rounded-full cursor-sw-resize" @mousedown.stop="startDragging({ event: $event, handle: 'sw' })"></div>
            <div class="absolute -bottom-1 -right-1 w-3 h-3 bg-blue-500 rounded-full cursor-se-resize" @mousedown.stop="startDragging({ event: $event, handle: 'se' })"></div>
            <div class="absolute top-1/2 -left-1 -translate-y-1/2 w-3 h-3 bg-blue-500 rounded-full cursor-w-resize" @mousedown.stop="startDragging({ event: $event, handle: 'w' })"></div>
            <div class="absolute top-1/2 -right-1 -translate-y-1/2 w-3 h-3 bg-blue-500 rounded-full cursor-e-resize" @mousedown.stop="startDragging({ event: $event, handle: 'e' })"></div>
            <div class="absolute -top-1 left-1/2 -translate-x-1/2 w-3 h-3 bg-blue-500 rounded-full cursor-n-resize" @mousedown.stop="startDragging({ event: $event, handle: 'n' })"></div>
            <div class="absolute -bottom-1 left-1/2 -translate-x-1/2 w-3 h-3 bg-blue-500 rounded-full cursor-s-resize" @mousedown.stop="startDragging({ event: $event, handle: 's' })"></div>
          </div>
        </div>
      </div>

      <!-- Sidebar -->
      <div
        class="flex flex-col gap-4 overflow-hidden transition-all duration-300 ease-in-out border-l border-gray-800 bg-black/20 backdrop-blur-sm"
        :class="isSidebarOpen ? 'w-48 px-3' : 'w-0 px-0 opacity-0'"
      >
        <div class="flex items-center justify-between mt-2 px-1">
          <span class="text-[10px] font-bold text-gray-400 uppercase tracking-widest">Tools</span>
        </div>

        <div class="flex flex-col gap-5 flex-1 overflow-y-auto pr-1 scrollbar-thin">
          <!-- Selection Section -->
          <div class="space-y-2">
            <span class="text-[10px] font-bold text-gray-500 uppercase tracking-widest px-1">Selection</span>
            <div class="bg-gray-800 p-2 rounded-xl border border-gray-700 space-y-3">
              <!-- Shape -->
              <div class="flex items-center gap-1 bg-gray-900/50 p-1 rounded-lg">
                <button
                  @click="selection.shape = 'rectangle'"
                  class="flex-1 p-1.5 rounded-md transition-all flex items-center justify-center"
                  :class="selection.shape === 'rectangle' ? 'bg-blue-600 text-white shadow-lg' : 'text-gray-500 hover:text-gray-300'"
                  title="Rectangular Selection"
                >
                  <Square class="w-3.5 h-3.5" />
                </button>
                <button
                  @click="selection.shape = 'ellipse'"
                  class="flex-1 p-1.5 rounded-md transition-all flex items-center justify-center"
                  :class="selection.shape === 'ellipse' ? 'bg-blue-600 text-white shadow-lg' : 'text-gray-500 hover:text-gray-300'"
                  title="Elliptical Selection"
                >
                  <Circle class="w-3.5 h-3.5" />
                </button>
              </div>

              <!-- Selection Actions -->
              <div class="flex flex-col gap-1.5" :class="{ 'opacity-30 pointer-events-none': selection.status === 'none' }">
                <button
                  @click="executeAction({ action: 'crop' })"
                  data-testid="image-editor-action-crop"
                  class="w-full py-1.5 bg-gray-900/50 hover:bg-blue-600 text-white rounded-lg text-[10px] font-bold transition-all flex items-center gap-2 px-2 border border-gray-700"
                  title="Crop to selection"
                >
                  <CropIcon class="w-3 h-3" />
                  <span>Crop</span>
                </button>
                <button
                  @click="executeAction({ action: 'mask-outside' })"
                  data-testid="image-editor-action-mask-out"
                  class="w-full py-1.5 bg-gray-900/50 hover:bg-blue-600 text-white rounded-lg text-[10px] font-bold transition-all flex items-center gap-2 px-2 border border-gray-700"
                  title="Fill everything outside selection"
                >
                  <Square class="w-3 h-3" />
                  <span>Mask Out</span>
                </button>
                <button
                  @click="executeAction({ action: 'mask-inside' })"
                  data-testid="image-editor-action-mask-in"
                  class="w-full py-1.5 bg-gray-900/50 hover:bg-blue-600 text-white rounded-lg text-[10px] font-bold transition-all flex items-center gap-2 px-2 border border-gray-700"
                  title="Fill selection area"
                >
                  <Eraser class="w-3 h-3" />
                  <span>Mask In</span>
                </button>
              </div>

              <!-- Fill Color -->
              <div class="space-y-2">
                <div class="flex items-center justify-between px-1">
                  <div class="flex gap-1.5">
                    <button
                      @click="selectedFill = TRANSPARENT"
                      class="w-6 h-6 rounded-md border-2 transition-all flex items-center justify-center bg-gray-700"
                      :class="selectedFill === TRANSPARENT ? 'border-blue-500 scale-110 shadow-lg' : 'border-transparent'"
                      title="Transparent"
                    >
                      <div class="w-2.5 h-2.5 border border-red-500/50 rotate-45"></div>
                    </button>
                    <button
                      @click="selectedFill = '#ffffff'"
                      class="w-6 h-6 rounded-md border-2 transition-all bg-white"
                      :class="selectedFill === '#ffffff' ? 'border-blue-500 scale-110 shadow-lg' : 'border-transparent'"
                      title="White"
                    ></button>
                    <button
                      @click="selectedFill = '#000000'"
                      class="w-6 h-6 rounded-md border-2 transition-all bg-black"
                      :class="selectedFill === '#000000' ? 'border-blue-500 scale-110 shadow-lg' : 'border-transparent'"
                      title="Black"
                    ></button>
                  </div>

                  <button
                    @click="isPickingColor = !isPickingColor"
                    class="p-1.5 rounded-lg transition-colors"
                    :class="isPickingColor ? 'bg-blue-600 text-white' : 'text-gray-400 hover:text-white hover:bg-gray-700'"
                    title="Pick color from canvas"
                  >
                    <Pipette class="w-3.5 h-3.5" />
                  </button>
                </div>

                <div class="flex items-center gap-2 px-1">
                  <input
                    type="color"
                    :value="typeof selectedFill === 'string' ? selectedFill : '#000000'"
                    @input="(e) => selectedFill = (e.target as HTMLInputElement).value"
                    class="w-full h-8 bg-transparent cursor-pointer rounded border border-gray-700"
                  />
                </div>

                <!-- Color History -->
                <div v-if="colorHistory.length > 0" class="px-1 pt-1">
                  <span class="text-[8px] font-bold text-gray-500 uppercase tracking-tighter mb-1 block">Recent</span>
                  <div class="flex flex-wrap gap-1">
                    <button
                      v-for="color in colorHistory"
                      :key="String(color)"
                      @click="selectedFill = color"
                      class="w-4 h-4 rounded-sm border transition-all"
                      :class="selectedFill === color ? 'border-blue-500 scale-110' : 'border-gray-700'"
                      :style="{ backgroundColor: typeof color === 'string' ? color : 'transparent' }"
                      :title="String(color)"
                    >
                      <div v-if="color === TRANSPARENT" class="w-full h-full border border-red-500/50 rotate-45"></div>
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <!-- Transform Section -->
          <div class="space-y-2">
            <span class="text-[10px] font-bold text-gray-500 uppercase tracking-widest px-1">Transform</span>
            <div class="bg-gray-800 p-2 rounded-xl border border-gray-700">
              <div class="grid grid-cols-2 gap-1.5">
                <button @click="applyTransform({ type: 'rotate-l' })" class="p-1.5 bg-gray-900/50 text-gray-400 hover:text-white hover:bg-gray-700 rounded-lg transition-colors flex items-center justify-center" title="Rotate Left">
                  <RotateCcw class="w-3.5 h-3.5" />
                </button>
                <button @click="applyTransform({ type: 'rotate-r' })" class="p-1.5 bg-gray-900/50 text-gray-400 hover:text-white hover:bg-gray-700 rounded-lg transition-colors flex items-center justify-center" title="Rotate Right">
                  <RotateCw class="w-3.5 h-3.5" />
                </button>
                <button @click="applyTransform({ type: 'flip-h' })" class="p-1.5 bg-gray-900/50 text-gray-400 hover:text-white hover:bg-gray-700 rounded-lg transition-colors flex items-center justify-center" title="Flip Horizontal">
                  <FlipHorizontal class="w-3.5 h-3.5" />
                </button>
                <button @click="applyTransform({ type: 'flip-v' })" class="p-1.5 bg-gray-900/50 text-gray-400 hover:text-white hover:bg-gray-700 rounded-lg transition-colors flex items-center justify-center" title="Flip Vertical">
                  <FlipVertical class="w-3.5 h-3.5" />
                </button>
              </div>
              <button @click="initEditor" class="w-full mt-2 py-1.5 text-red-400 hover:text-red-300 hover:bg-red-900/20 rounded-lg transition-colors text-[9px] font-bold border border-red-900/30 flex items-center justify-center gap-2" title="Reset Image">
                <RefreshCcw class="w-2.5 h-2.5" />
                <span>Reset</span>
              </button>
            </div>
          </div>

          <!-- Resize Section -->
          <div class="space-y-2">
            <span class="text-[10px] font-bold text-gray-500 uppercase tracking-widest px-1">Resize (px)</span>
            <div class="bg-gray-800 p-2 rounded-xl border border-gray-700 space-y-2">
              <div class="flex items-center gap-1.5">
                <input
                  type="number"
                  v-model.number="resizeW"
                  class="flex-1 w-0 bg-gray-900 border border-gray-700 rounded-lg px-1.5 py-1 text-[10px] font-mono focus:outline-none focus:ring-1 focus:ring-blue-500 text-center"
                />
                <button
                  @click="resizeLock = resizeLock === 'locked' ? 'free' : 'locked'"
                  class="p-1 rounded-lg transition-colors"
                  :class="resizeLock === 'locked' ? 'text-blue-400 bg-gray-900' : 'text-gray-600'"
                  :title="resizeLock === 'locked' ? 'Maintain aspect ratio' : 'Free resizing'"
                >
                  <component :is="resizeLock === 'locked' ? Link : Link2Off" class="w-3 h-3" />
                </button>
                <input
                  type="number"
                  v-model.number="resizeH"
                  class="flex-1 w-0 bg-gray-900 border border-gray-700 rounded-lg px-1.5 py-1 text-[10px] font-mono focus:outline-none focus:ring-1 focus:ring-blue-500 text-center"
                />
              </div>
              <button
                @click="applyResize"
                class="w-full py-1.5 bg-gray-700 hover:bg-gray-600 text-[9px] font-bold rounded-lg transition-colors"
              >
                Apply Resize
              </button>
            </div>
          </div>

          <!-- Zoom Section -->
          <div class="space-y-2">
            <span class="text-[10px] font-bold text-gray-500 uppercase tracking-widest px-1">Zoom</span>
            <div class="bg-gray-800 p-2 rounded-xl border border-gray-700">
              <div class="flex items-center gap-1 bg-gray-900/50 p-1 rounded-lg">
                <button @click="zoom = Math.max(0.1, zoom / 1.2)" class="p-1.5 text-gray-400 hover:text-white hover:bg-gray-700 rounded-md transition-colors flex-1 flex justify-center" title="Zoom Out">
                  <ZoomOut class="w-3.5 h-3.5" />
                </button>
                <button @click="zoom = 1; panOffset = { x: 0, y: 0 }" class="px-2 text-[10px] font-bold text-gray-400 hover:text-white transition-colors flex-[2] text-center" title="Reset Zoom">
                  {{ Math.round(zoom * 100) }}%
                </button>
                <button @click="zoom = Math.min(10, zoom * 1.2)" class="p-1.5 text-gray-400 hover:text-white hover:bg-gray-700 rounded-md transition-colors flex-1 flex justify-center" title="Zoom In">
                  <ZoomIn class="w-3.5 h-3.5" />
                </button>
              </div>
              <p class="text-[8px] text-gray-500 mt-2 text-center leading-tight">
                Wheel to zoom. Middle-click or Alt+Drag to pan.
              </p>
            </div>
          </div>

          <!-- Format Section -->
          <div class="space-y-2 pb-4">
            <span class="text-[10px] font-bold text-gray-500 uppercase tracking-widest px-1">Output Format</span>
            <div class="bg-gray-800 p-1 rounded-xl border border-gray-700 grid grid-cols-2 gap-1">
              <button
                v-for="format in ([{ label: 'Orig.', value: 'original' }, { label: 'PNG', value: 'image/png' }, { label: 'JPG', value: 'image/jpeg' }, { label: 'WebP', value: 'image/webp' }] as const)"
                :key="format.value"
                @click="selectedFormat = format.value"
                class="py-1 rounded-lg text-[9px] font-bold transition-all text-center"
                :class="selectedFormat === format.value ? 'bg-gray-600 text-white' : 'text-gray-400 hover:text-gray-200 hover:bg-gray-700'"
              >
                {{ format.label }}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Confirm Discard Dialog -->
    <CustomDialog
      :show="showCloseConfirm"
      title="Discard Changes?"
      message="You have unsaved changes. Are you sure you want to close and discard them?"
      confirm-button-text="Discard"
      confirm-button-variant="danger"
      @confirm="confirmClose"
      @cancel="showCloseConfirm = false"
    />
  </div>
</template>

<style scoped>
.animate-in {
  animation: fade-in 0.2s ease-out;
}
@keyframes fade-in {
  from { opacity: 0; }
  to { opacity: 1; }
}

/* Hide arrow buttons for number input */
input::-webkit-outer-spin-button,
input::-webkit-inner-spin-button {
  -webkit-appearance: none;
  margin: 0;
}
input[type=number] {
  -moz-appearance: textfield;
}
</style>
