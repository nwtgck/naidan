<script setup lang="ts">
import { computed, defineAsyncComponent, ref } from 'vue';
import {
  AlertTriangleIcon,
  DatabaseIcon,
  EyeIcon,
  EyeOffIcon,
  KeyRoundIcon,
  Loader2Icon,
  RefreshCwIcon,
  ShieldCheckIcon,
} from 'lucide-vue-next';
import { validateEncryptionPassphrase } from '@/00-storage/service/opfs-encryption/passphrase';
import { useFileExplorerModal } from '@/features/file-explorer/composables/useFileExplorerModal';
import type {
  OpfsEncryptionStartupGate,
  OpfsEncryptionStartupPhase,
} from '@/logic/startup/opfs-encryption-startup-gate';
import { ensureStrings, lazyStrings } from '@/strings';
import OpfsEncryptionUnlockButton from './OpfsEncryptionUnlockButton.vue';
import {
  OPFS_ENCRYPTION_UNLOCK_MINIMUM_SEAT_START_MS,
  OPFS_ENCRYPTION_UNLOCK_POST_SUCCESS_HOLD_DURATION_MS,
  OPFS_ENCRYPTION_UNLOCK_REDUCED_MOTION_DURATION_MS,
  OPFS_ENCRYPTION_UNLOCK_SUCCESS_ANIMATION_DURATION_MS,
  type OpfsEncryptionUnlockButtonState,
} from './opfs-encryption-unlock-button-motion';

const FileExplorerModal = defineAsyncComponent(
  () => import('@/features/file-explorer/components/FileExplorerModal.vue'),
);

const props = defineProps<{
  gate: OpfsEncryptionStartupGate,
}>();

function resolveInitialUnlockButtonState({
  phase,
}: {
  phase: OpfsEncryptionStartupPhase,
}): OpfsEncryptionUnlockButtonState {
  switch (phase) {
  case 'locked':
    return 'ready';
  case 'unlocking':
    return 'retracting';
  case 'preparing_application':
  case 'application_failed':
    return 'unlocked';
  default: {
    const _ex: never = phase;
    throw new Error(`Unhandled OPFS encryption startup phase: ${String(_ex)}`);
  }
  }
}

const passphrase = ref('');
const showPassphrase = ref(false);
const working = ref(false);
const unlockButtonState = ref<OpfsEncryptionUnlockButtonState>(
  resolveInitialUnlockButtonState({ phase: props.gate.phase.value }),
);
const errorMessage = ref<string>();
const { isFileExplorerOpen, openFileExplorer } = useFileExplorerModal();

const inspection = computed(() => props.gate.inspection.value);
const gatePhase = computed(() => props.gate.phase.value);
const isRecoveryRequired = computed(() => inspection.value.type === 'recovery_required');
const isTransitioning = computed(() => inspection.value.type === 'transitioning');
const isPreparingApplication = computed(() => gatePhase.value === 'preparing_application');
const isApplicationFailed = computed(() => gatePhase.value === 'application_failed');
const passphraseValidation = computed(() => validateEncryptionPassphrase({
  passphrase: passphrase.value,
}));
const boundaryWhitespaceWarning = computed(() => (
  passphraseValidation.value.type === 'boundary_whitespace'
));
const hasLineBreak = computed(() => (
  passphraseValidation.value.type === 'line_break'
));
const transitionOperation = computed(() => {
  const value = inspection.value;
  switch (value.type) {
  case 'transitioning':
    return value.operation.type;
  case 'encrypted':
  case 'recovery_required':
    return undefined;
  default: {
    const _ex: never = value;
    throw new Error(`Unhandled OPFS encryption inspection: ${String(_ex)}`);
  }
  }
});
const title = computed(() => {
  if (isApplicationFailed.value) {
    return lazyStrings.opfsEncryption__naidan_could_not_finish_loading();
  }
  if (isPreparingApplication.value) {
    return lazyStrings.opfsEncryption__preparing_naidan();
  }
  if (isRecoveryRequired.value) {
    return lazyStrings.opfsEncryption__encrypted_storage_needs_recovery();
  }
  const operation = transitionOperation.value;
  switch (operation) {
  case undefined:
    return lazyStrings.opfsEncryption__unlock_encrypted_storage();
  case 'encrypting':
    return lazyStrings.opfsEncryption__resume_opfs_encryption();
  case 'decrypting':
    return lazyStrings.opfsEncryption__resume_opfs_decryption();
  case 'reencrypting':
    return lazyStrings.opfsEncryption__resume_opfs_reencryption();
  default: {
    const _ex: never = operation;
    throw new Error(`Unhandled OPFS encryption operation: ${String(_ex)}`);
  }
  }
});

function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

async function waitForMilliseconds({ milliseconds }: { milliseconds: number }): Promise<void> {
  await new Promise<void>((resolve) => {
    window.setTimeout(resolve, milliseconds);
  });
}

async function submitPassphrase(): Promise<void> {
  if (
    working.value
    || gatePhase.value !== 'locked'
    || passphrase.value.length === 0
    || hasLineBreak.value
  ) {
    return;
  }

  const reducedMotion = prefersReducedMotion();
  const minimumSeatStartMilliseconds = reducedMotion
    ? OPFS_ENCRYPTION_UNLOCK_REDUCED_MOTION_DURATION_MS
    : OPFS_ENCRYPTION_UNLOCK_MINIMUM_SEAT_START_MS;
  const successAnimationDurationMilliseconds = reducedMotion
    ? OPFS_ENCRYPTION_UNLOCK_REDUCED_MOTION_DURATION_MS
    : OPFS_ENCRYPTION_UNLOCK_SUCCESS_ANIMATION_DURATION_MS;

  working.value = true;
  unlockButtonState.value = 'retracting';
  errorMessage.value = undefined;
  try {
    /**
     * WHY: The final mechanical snap represents authenticated decryption, not
     * elapsed time. Start decryption and the visual retraction together, then
     * hold at zero velocity until both prerequisites have completed. A slow
     * unlock therefore extends the still frame instead of opening the lock
     * before authentication succeeds.
     */
    await Promise.all([
      props.gate.unlockWithPassphrase({ passphrase: passphrase.value }),
      waitForMilliseconds({ milliseconds: minimumSeatStartMilliseconds }),
    ]);

    unlockButtonState.value = 'seating';
    await waitForMilliseconds({ milliseconds: successAnimationDurationMilliseconds });
    unlockButtonState.value = 'unlocked';

    /**
     * WHY: The tilted open lock and the uncovered result are the visual
     * confirmation of successful authenticated decryption. Preserve that
     * completed frame for a full second before allowing the presentation
     * boundary to disappear, even when the application behind it is ready.
     */
    await waitForMilliseconds({
      milliseconds: OPFS_ENCRYPTION_UNLOCK_POST_SUCCESS_HOLD_DURATION_MS,
    });
    props.gate.reportUnlockPresentationReady();
  } catch (error) {
    unlockButtonState.value = 'ready';
    errorMessage.value = error instanceof Error ? error.message : String(error);
  } finally {
    working.value = false;
  }
}

async function retryInspection(): Promise<void> {
  if (working.value || gatePhase.value !== 'locked') {
    return;
  }
  working.value = true;
  errorMessage.value = undefined;
  try {
    await props.gate.retryInspection();
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : String(error);
  } finally {
    working.value = false;
  }
}

async function handlePassphrasePaste({ event }: { event: ClipboardEvent }): Promise<void> {
  const pastedText = event.clipboardData?.getData('text') ?? '';
  const validation = validateEncryptionPassphrase({ passphrase: pastedText });
  switch (validation.type) {
  case 'valid':
  case 'boundary_whitespace':
    errorMessage.value = undefined;
    return;
  case 'line_break':
    event.preventDefault();
    errorMessage.value = await ensureStrings.opfsEncryption__passphrases_cannot_contain_line_breaks();
    return;
  default: {
    const _ex: never = validation;
    throw new Error(`Unhandled passphrase validation result: ${String(_ex)}`);
  }
  }
}

defineExpose({
  ...((__BUILD_MODE_IS_TEST__ && {
    TEST_ONLY: {
      submitPassphrase,
      retryInspection,
    },
  }) || {}),
});
</script>

<template>
  <main
    data-testid="opfs-encryption-unlock-view"
    tw-class="fixed inset-0 z-[90] min-h-dvh overflow-y-auto bg-gray-50 dark:bg-gray-950 px-4 py-10 flex items-center justify-center"
  >
    <section tw-class="w-full max-w-xl rounded-[2rem] border border-gray-200/80 dark:border-gray-800 bg-white dark:bg-gray-900 shadow-2xl shadow-gray-900/10 dark:shadow-black/30 overflow-hidden">
      <div tw-class="px-7 py-7 sm:px-9 border-b border-gray-100 dark:border-gray-800 bg-gradient-to-br from-blue-50/80 via-white to-white dark:from-blue-950/25 dark:via-gray-900 dark:to-gray-900">
        <div tw-class="flex items-start gap-4">
          <div tw-class="shrink-0 w-12 h-12 rounded-2xl bg-blue-600 text-white flex items-center justify-center shadow-lg shadow-blue-500/20">
            <ShieldCheckIcon tw-class="w-6 h-6" />
          </div>
          <div tw-class="min-w-0 space-y-1.5">
            <div tw-class="flex flex-wrap items-center gap-2">
              <h1 tw-class="text-xl font-extrabold text-gray-900 dark:text-white tracking-tight">
                {{ title }}
              </h1>
              <span tw-class="text-[9px] px-2 py-1 rounded-full border border-amber-200 dark:border-amber-900/60 bg-amber-50 dark:bg-amber-950/30 text-amber-700 dark:text-amber-400 font-bold uppercase tracking-wider">
                {{ lazyStrings.opfsEncryption__experimental() }}
              </span>
            </div>
            <p tw-class="text-sm leading-relaxed text-gray-500 dark:text-gray-400">
              <template v-if="isApplicationFailed">
                {{ lazyStrings.opfsEncryption__storage_unlocked_but_naidan_could_not_finish_loading() }}
              </template>
              <template v-else-if="isPreparingApplication">
                {{ lazyStrings.opfsEncryption__storage_unlocked_preparing_application() }}
              </template>
              <template v-else-if="isRecoveryRequired">
                {{ lazyStrings.opfsEncryption__could_not_read_encryption_control_state() }}
              </template>
              <template v-else-if="isTransitioning">
                {{ lazyStrings.opfsEncryption__interrupted_encryption_operation() }}
              </template>
              <template v-else>
                {{ lazyStrings.opfsEncryption__enter_passphrase_for_opfs_storage() }}
              </template>
            </p>
          </div>
        </div>
      </div>

      <div tw-class="px-7 py-7 sm:px-9 space-y-6">
        <div
          v-if="isPreparingApplication"
          data-testid="opfs-encryption-preparing-application"
          tw-class="rounded-2xl border border-blue-100 dark:border-blue-900/50 bg-blue-50/80 dark:bg-blue-950/20 px-5 py-6 text-sm text-blue-800 dark:text-blue-300 flex items-center gap-3"
        >
          <Loader2Icon tw-class="w-5 h-5 shrink-0 animate-spin" />
          {{ lazyStrings.opfsEncryption__storage_unlocked_preparing_application() }}
        </div>

        <div
          v-else-if="isApplicationFailed"
          data-testid="opfs-encryption-application-failed"
          tw-class="space-y-3"
        >
          <div tw-class="rounded-2xl border border-red-200 dark:border-red-900/60 bg-red-50/80 dark:bg-red-950/20 p-4 text-sm text-red-800 dark:text-red-300 break-words">
            {{ gate.applicationError.value instanceof Error ? gate.applicationError.value.message : String(gate.applicationError.value) }}
          </div>
        </div>

        <form
          v-if="!isRecoveryRequired && !isApplicationFailed"
          tw-class="space-y-3"
          @submit.prevent="submitPassphrase"
        >
          <label tw-class="block text-xs font-bold text-gray-600 dark:text-gray-300">
            {{ lazyStrings.opfsEncryption__passphrase() }}
          </label>
          <div tw-class="relative">
            <KeyRoundIcon tw-class="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
            <input
              v-model="passphrase"
              data-testid="opfs-encryption-unlock-passphrase"
              :type="showPassphrase ? 'text' : 'password'"
              autocomplete="current-password"
              :disabled="working || gatePhase !== 'locked'"
              tw-class="w-full rounded-2xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-950 pl-11 pr-12 py-3.5 text-sm text-gray-900 dark:text-white outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-500 disabled:cursor-default disabled:opacity-70"
              @paste="handlePassphrasePaste({ event: $event })"
            />
            <button
              type="button"
              data-testid="opfs-encryption-unlock-passphrase-visibility"
              :disabled="working || gatePhase !== 'locked'"
              tw-class="absolute right-3 top-1/2 -translate-y-1/2 p-2 rounded-lg text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 disabled:cursor-default"
              :title="showPassphrase ? lazyStrings.opfsEncryption__hide_passphrase() : lazyStrings.opfsEncryption__show_passphrase()"
              @click="showPassphrase = !showPassphrase"
            >
              <EyeOffIcon v-if="showPassphrase" tw-class="w-4 h-4" />
              <EyeIcon v-else tw-class="w-4 h-4" />
            </button>
          </div>
          <p v-if="boundaryWhitespaceWarning" tw-class="text-xs text-amber-700 dark:text-amber-400 flex items-start gap-2">
            <AlertTriangleIcon tw-class="w-4 h-4 shrink-0 mt-0.5" />
            {{ lazyStrings.opfsEncryption__leading_or_trailing_whitespace_is_part_of_passphrase() }}
          </p>
          <p v-if="hasLineBreak" tw-class="text-xs text-red-600 dark:text-red-400">
            {{ lazyStrings.opfsEncryption__passphrases_cannot_contain_line_breaks() }}
          </p>
          <p v-if="errorMessage" tw-class="text-xs text-red-600 dark:text-red-400 break-words">
            {{ errorMessage }}
          </p>
          <OpfsEncryptionUnlockButton
            :state="unlockButtonState"
            :disabled="working || gatePhase !== 'locked' || passphrase.length === 0 || hasLineBreak"
            :label="isTransitioning ? lazyStrings.opfsEncryption__unlock_and_resume() : lazyStrings.opfsEncryption__unlock_storage()"
            :result-label="lazyStrings.opfsEncryption__unlocked()"
          />
        </form>

        <div v-if="isRecoveryRequired" tw-class="space-y-4">
          <div tw-class="rounded-2xl border border-amber-200 dark:border-amber-900/60 bg-amber-50/80 dark:bg-amber-950/20 p-4 text-sm text-amber-900 dark:text-amber-300 break-words">
            {{ inspection.type === 'recovery_required' && inspection.error instanceof Error ? inspection.error.message : lazyStrings.opfsEncryption__encryption_state_is_unreadable() }}
          </div>
          <button
            type="button"
            :disabled="working"
            tw-class="w-full rounded-2xl border border-gray-200 dark:border-gray-700 px-5 py-3 text-sm font-bold text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-800 flex items-center justify-center gap-2"
            @click="retryInspection"
          >
            <RefreshCwIcon tw-class="w-4 h-4" :class="working ? 'animate-spin' : ''" />
            {{ lazyStrings.opfsEncryption__retry_after_recovery() }}
          </button>
          <p v-if="errorMessage" tw-class="text-xs text-red-600 dark:text-red-400 break-words">
            {{ errorMessage }}
          </p>
        </div>

        <div tw-class="pt-5 border-t border-gray-100 dark:border-gray-800 flex flex-col sm:flex-row gap-3 sm:items-center sm:justify-between">
          <div tw-class="text-xs text-gray-500 dark:text-gray-400 space-y-1">
            <p>{{ lazyStrings.opfsEncryption__raw_opfs_access_does_not_decrypt() }}</p>
            <p v-if="isTransitioning" tw-class="text-amber-700 dark:text-amber-400">
              {{ lazyStrings.opfsEncryption__changing_raw_opfs_during_transition_can_prevent_recovery() }}
            </p>
          </div>
          <button
            type="button"
            tw-class="shrink-0 inline-flex items-center justify-center gap-2 rounded-xl border border-gray-200 dark:border-gray-700 px-4 py-2.5 text-xs font-bold text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-800"
            @click="openFileExplorer({ options: { kind: 'opfs-root' } })"
          >
            <DatabaseIcon tw-class="w-4 h-4" />
            {{ lazyStrings.opfsEncryption__open_raw_opfs_explorer() }}
          </button>
        </div>
      </div>
    </section>
  </main>

  <FileExplorerModal v-if="isFileExplorerOpen" />
</template>
