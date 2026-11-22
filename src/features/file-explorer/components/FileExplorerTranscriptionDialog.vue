<script setup lang="ts">
import { onBeforeUnmount, onMounted, useTemplateRef } from 'vue';
import { XIcon } from 'lucide-vue-next';
import AudioTranscriptionWorkspace from '@/features/audio-transcription/components/AudioTranscriptionWorkspace.vue';
import { lazyStrings } from '@/strings';

defineProps<{
  file: File,
  saveText: (({ text }: { text: string }) => Promise<void>) | undefined,
}>();
const emit = defineEmits<{ close: [] }>();
const dialog = useTemplateRef<HTMLElement>('dialog');
const opener = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;

onMounted(() => dialog.value?.focus({ preventScroll: true }));
onBeforeUnmount(() => {
  if (opener?.isConnected && (document.activeElement === document.body || dialog.value?.contains(document.activeElement))) {
    opener.focus({ preventScroll: true });
  }
});

function handleKeyboard({ event }: { event: KeyboardEvent }): void {
  const panel = dialog.value;
  if (panel === null || event.defaultPrevented || event.isComposing) {
    return;
  }
  if (event.key === 'Escape') {
    event.preventDefault();
    emit('close');
    return;
  }
  if (event.key !== 'Tab') {
    return;
  }
  const controls = [...panel.querySelectorAll<HTMLElement>('button, a[href], input, select, textarea, summary, [tabindex]')]
    .filter(control => {
      const closedDetails = control.closest('details:not([open])');
      return control.tabIndex >= 0 && !control.matches(':disabled') && !control.closest('[inert], [hidden]')
        && (closedDetails === null || closedDetails.querySelector(':scope > summary')?.contains(control));
    });
  const first = controls[0];
  const last = controls.at(-1);
  if (event.shiftKey && (document.activeElement === first || document.activeElement === panel)) {
    event.preventDefault();
    last?.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first?.focus();
  }
}

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <Teleport to="body">
    <div tw-class="fixed inset-0 z-[140] flex items-center justify-center bg-black/40 p-2 backdrop-blur-[2px] sm:p-4">
      <section ref="dialog" data-testid="file-explorer-transcription-dialog" role="dialog" aria-modal="true" :aria-label="lazyStrings.launcher__audio_transcription()" tabindex="-1" @keydown.stop="handleKeyboard({ event: $event })" tw-class="h-[90dvh] w-full max-w-5xl overflow-hidden rounded-2xl border border-gray-200/90 bg-white shadow-2xl outline-none dark:border-gray-700/80 dark:bg-gray-900">
        <AudioTranscriptionWorkspace source="file" :file="file" :save-text="saveText">
          <template #header-actions>
            <button type="button" data-testid="file-explorer-transcription-close" :aria-label="lazyStrings.fileExplorer__close()" @click="emit('close')" tw-class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-gray-500 hover:bg-gray-100 focus-visible:outline-2 focus-visible:outline-blue-500 dark:text-gray-400 dark:hover:bg-gray-800">
              <XIcon aria-hidden="true" tw-class="h-4 w-4" />
            </button>
          </template>
        </AudioTranscriptionWorkspace>
      </section>
    </div>
  </Teleport>
</template>
