<script setup lang="ts">
import { computed, defineAsyncComponent, onMounted, ref, watch } from 'vue';
import {
  AlertTriangleIcon,
  EyeIcon,
  EyeOffIcon,
  KeyRoundIcon,
  Loader2Icon,
  LockKeyholeIcon,
  RefreshCwIcon,
  ShieldAlertIcon,
} from 'lucide-vue-next';
import { storageService } from '@/00-storage/service';
import type { OpfsEncryptionInspection } from '@/00-storage/service/opfs-encryption/bootstrap';
import { validateEncryptionPassphrase } from '@/00-storage/service/opfs-encryption/passphrase';
import { useConfirm } from '@/composables/useConfirm';
import { useOpfsEncryptionTransition } from '@/features/opfs-encryption/composables/useOpfsEncryptionTransition';
import { ensureStrings, lazyStrings } from '@/strings';

const OpfsEncryptionRecoverySourceViewer = defineAsyncComponent(
  () => import('./OpfsEncryptionRecoverySourceViewer.vue'),
);

const props = defineProps<{
  storageType: 'local' | 'opfs' | 'memory',
}>();

const { showConfirm } = useConfirm();
const {
  beginLocalOperation,
  updateProgress,
  finishLocalOperation,
} = useOpfsEncryptionTransition();
const inspection = ref<OpfsEncryptionInspection>({ type: 'plain' });
const loading = ref(false);
const setupOpen = ref(false);
const passphraseChangeOpen = ref(false);
const recoverySourceOpen = ref(false);
const passphrase = ref('');
const confirmPassphrase = ref('');
const newPassphrase = ref('');
const confirmNewPassphrase = ref('');
const showPassphrase = ref(false);
const showConfirmPassphrase = ref(false);
const showNewPassphrase = ref(false);
const showConfirmNewPassphrase = ref(false);
const errorMessage = ref<string>();
const experimentalAccepted = ref(false);

const available = computed(() => props.storageType === 'opfs');
const enabled = computed(() => inspection.value.type === 'encrypted');
const operationLocked = computed(() => inspection.value.type === 'transitioning');
const passphraseValidation = computed(() => validateEncryptionPassphrase({
  passphrase: passphrase.value,
}));
const boundaryWhitespaceWarning = computed(() => (
  passphraseValidation.value.type === 'boundary_whitespace'
));
const confirmPassphraseValidation = computed(() => validateEncryptionPassphrase({
  passphrase: confirmPassphrase.value,
}));
const newPassphraseValidation = computed(() => validateEncryptionPassphrase({
  passphrase: newPassphrase.value,
}));
const confirmNewPassphraseValidation = computed(() => validateEncryptionPassphrase({
  passphrase: confirmNewPassphrase.value,
}));
const setupCanSubmit = computed(() => (
  passphrase.value.length > 0
  && passphrase.value === confirmPassphrase.value
  && passphraseValidation.value.type !== 'line_break'
  && confirmPassphraseValidation.value.type !== 'line_break'
  && experimentalAccepted.value
  && !loading.value
));
const passphraseChangeCanSubmit = computed(() => (
  newPassphrase.value.length > 0
  && newPassphrase.value === confirmNewPassphrase.value
  && newPassphraseValidation.value.type !== 'line_break'
  && confirmNewPassphraseValidation.value.type !== 'line_break'
  && !loading.value
));

async function refreshInspection(): Promise<'updated' | 'failed'> {
  if (!available.value) {
    inspection.value = { type: 'plain' };
    return 'updated';
  }
  loading.value = true;
  errorMessage.value = undefined;
  try {
    inspection.value = await storageService.inspectOpfsEncryption();
    return 'updated';
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : String(error);
    return 'failed';
  } finally {
    loading.value = false;
  }
}

function resetSetup(): void {
  setupOpen.value = false;
  passphrase.value = '';
  confirmPassphrase.value = '';
  experimentalAccepted.value = false;
  errorMessage.value = undefined;
}

function resetPassphraseChange(): void {
  passphraseChangeOpen.value = false;
  newPassphrase.value = '';
  confirmNewPassphrase.value = '';
  errorMessage.value = undefined;
}

async function prepareForStorageTransition(): Promise<void> {
  const transitionPreparation = await import(
    '@/features/opfs-encryption/prepare-for-storage-transition'
  );
  await transitionPreparation.prepareForOpfsEncryptionTransition();
}

async function rejectLineBreakPaste({ event }: { event: ClipboardEvent }): Promise<void> {
  const pastedText = event.clipboardData?.getData('text') ?? '';
  const validation = validateEncryptionPassphrase({ passphrase: pastedText });
  switch (validation.type) {
  case 'valid':
  case 'boundary_whitespace':
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

async function refreshInspectionAfterOperationError({
  error,
}: {
  error: unknown,
}): Promise<{
  errorMessage: string,
  inspectionRefresh: 'updated' | 'failed',
}> {
  const operationErrorMessage = error instanceof Error ? error.message : String(error);
  const inspectionRefresh = await refreshInspection();
  const inspectionErrorMessage = errorMessage.value;
  const combinedErrorMessage = inspectionErrorMessage === undefined
    ? operationErrorMessage
    : `${operationErrorMessage}
${inspectionErrorMessage}`;
  errorMessage.value = combinedErrorMessage;
  return {
    errorMessage: combinedErrorMessage,
    inspectionRefresh,
  };
}

function finishFailedLocalOperation({
  operationFailure,
}: {
  operationFailure: {
    errorMessage: string,
    inspectionRefresh: 'updated' | 'failed',
  },
}): void {
  switch (operationFailure.inspectionRefresh) {
  case 'failed':
    finishLocalOperation({
      outcome: 'recovery_required',
      errorMessage: operationFailure.errorMessage,
    });
    return;
  case 'updated':
    break;
  default: {
    const _ex: never = operationFailure.inspectionRefresh;
    throw new Error(`Unhandled inspection refresh result: ${String(_ex)}`);
  }
  }
  const currentInspection = inspection.value;
  switch (currentInspection.type) {
  case 'plain':
  case 'encrypted':
    finishLocalOperation({
      outcome: 'rolled_back',
      errorMessage: operationFailure.errorMessage,
    });
    return;
  case 'transitioning':
  case 'recovery_required':
    finishLocalOperation({
      outcome: 'recovery_required',
      errorMessage: operationFailure.errorMessage,
    });
    return;
  default: {
    const _ex: never = currentInspection;
    throw new Error(`Unhandled OPFS encryption inspection: ${String(_ex)}`);
  }
  }
}

async function refreshExpectedInspection({
  expectedType,
}: {
  expectedType: 'plain' | 'encrypted',
}): Promise<void> {
  const nextInspection = await storageService.inspectOpfsEncryption();
  inspection.value = nextInspection;
  if (nextInspection.type !== expectedType) {
    throw new Error(
      `OPFS encryption transition completed with unexpected state: ${nextInspection.type}`,
    );
  }
}

async function handleToggle(): Promise<void> {
  if (!available.value || loading.value || operationLocked.value) {
    return;
  }
  if (!enabled.value) {
    setupOpen.value = true;
    return;
  }

  const confirmed = await showConfirm({
    title: await ensureStrings.opfsEncryption__turn_off_opfs_encryption(),
    message: await ensureStrings.opfsEncryption__decrypt_storage_explanation(),
    confirmButtonText: await ensureStrings.opfsEncryption__decrypt_storage(),
    confirmButtonVariant: 'danger',
  });
  if (!confirmed) {
    return;
  }
  loading.value = true;
  errorMessage.value = undefined;
  beginLocalOperation();
  try {
    await prepareForStorageTransition();
    await storageService.disableOpfsEncryption({
      signal: undefined,
      onProgress: updateProgress,
    });
    await refreshExpectedInspection({ expectedType: 'plain' });
    finishLocalOperation({ outcome: 'completed', errorMessage: undefined });
  } catch (error) {
    const operationFailure = await refreshInspectionAfterOperationError({ error });
    finishFailedLocalOperation({ operationFailure });
  } finally {
    loading.value = false;
  }
}

async function enableEncryption(): Promise<void> {
  if (!setupCanSubmit.value) {
    return;
  }
  loading.value = true;
  errorMessage.value = undefined;
  beginLocalOperation();
  try {
    await prepareForStorageTransition();
    await storageService.enableOpfsEncryption({
      passphrase: passphrase.value,
      signal: undefined,
      onProgress: updateProgress,
    });
    await refreshExpectedInspection({ expectedType: 'encrypted' });
    resetSetup();
    finishLocalOperation({ outcome: 'completed', errorMessage: undefined });
  } catch (error) {
    const operationFailure = await refreshInspectionAfterOperationError({ error });
    finishFailedLocalOperation({ operationFailure });
  } finally {
    loading.value = false;
  }
}

async function changePassphrase(): Promise<void> {
  if (!passphraseChangeCanSubmit.value) {
    return;
  }
  loading.value = true;
  errorMessage.value = undefined;
  try {
    await storageService.changeOpfsEncryptionPassphrase({
      passphrase: newPassphrase.value,
    });
    resetPassphraseChange();
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : String(error);
  } finally {
    loading.value = false;
  }
}

async function reencrypt(): Promise<void> {
  if (!enabled.value || loading.value) {
    return;
  }
  const confirmed = await showConfirm({
    title: await ensureStrings.opfsEncryption__re_encrypt_opfs_storage(),
    message: await ensureStrings.opfsEncryption__re_encrypt_storage_explanation(),
    confirmButtonText: await ensureStrings.opfsEncryption__re_encrypt_storage(),
  });
  if (!confirmed) {
    return;
  }
  loading.value = true;
  errorMessage.value = undefined;
  beginLocalOperation();
  try {
    await prepareForStorageTransition();
    await storageService.reencryptOpfsEncryption({
      signal: undefined,
      onProgress: updateProgress,
    });
    await refreshExpectedInspection({ expectedType: 'encrypted' });
    finishLocalOperation({ outcome: 'completed', errorMessage: undefined });
  } catch (error) {
    const operationFailure = await refreshInspectionAfterOperationError({ error });
    finishFailedLocalOperation({ operationFailure });
  } finally {
    loading.value = false;
  }
}


watch(() => props.storageType, () => {
  void refreshInspection();
});

onMounted(() => {
  void refreshInspection();
});

defineExpose({
  ...((__BUILD_MODE_IS_TEST__ && {
    TEST_ONLY: {
      refreshInspection,
      handleToggle,
      enableEncryption,
      changePassphrase,
      reencrypt,
    },
  }) || {}),
});
</script>

<template>
  <div tw-class="rounded-3xl border border-gray-100 dark:border-gray-800 bg-gray-50/50 dark:bg-gray-800/30 p-5 sm:p-6 shadow-sm space-y-4">
    <div tw-class="flex items-start justify-between gap-5">
      <div tw-class="flex items-start gap-3 min-w-0">
        <div tw-class="mt-0.5 w-9 h-9 rounded-xl flex items-center justify-center" :class="enabled ? 'bg-blue-100 dark:bg-blue-950/50 text-blue-600 dark:text-blue-400' : 'bg-gray-100 dark:bg-gray-800 text-gray-400'">
          <LockKeyholeIcon tw-class="w-4.5 h-4.5" />
        </div>
        <div tw-class="min-w-0 space-y-1">
          <h4 tw-class="font-bold text-sm text-gray-800 dark:text-white flex flex-wrap items-center gap-2">
            {{ lazyStrings.opfsEncryption__opfs_encryption() }}
            <span tw-class="text-[9px] px-1.5 py-0.5 bg-amber-50 dark:bg-amber-950/30 text-amber-700 dark:text-amber-400 rounded-lg font-bold uppercase tracking-wider border border-amber-100 dark:border-amber-900/50">{{ lazyStrings.opfsEncryption__experimental() }}</span>
          </h4>
          <p tw-class="text-xs leading-relaxed text-gray-500 dark:text-gray-400">
            {{ lazyStrings.opfsEncryption__transparently_encrypt_naidan_opfs_data() }}
          </p>
        </div>
      </div>

      <button
        type="button"
        role="switch"
        :aria-checked="enabled"
        :disabled="!available || loading || operationLocked"
        data-testid="opfs-encryption-toggle"
        tw-class="relative inline-flex shrink-0 w-12 h-7 items-center rounded-full transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        :class="enabled ? 'bg-blue-600' : 'bg-gray-300 dark:bg-gray-700'"
        @click="handleToggle"
      >
        <span
          tw-class="block w-5 h-5 rounded-full bg-white shadow transition-transform"
          :class="enabled ? 'translate-x-6' : 'translate-x-1'"
        />
      </button>
    </div>

    <div v-if="!available" tw-class="rounded-xl bg-gray-100/80 dark:bg-gray-900/60 px-3.5 py-2.5 text-xs text-gray-500 dark:text-gray-400">
      {{ lazyStrings.opfsEncryption__select_opfs_as_active_storage_to_enable_encryption() }}
    </div>

    <div v-else-if="inspection.type === 'transitioning'" tw-class="rounded-xl bg-amber-50 dark:bg-amber-950/20 border border-amber-100 dark:border-amber-900/50 px-3.5 py-2.5 text-xs text-amber-800 dark:text-amber-300 flex items-center gap-2">
      <Loader2Icon tw-class="w-4 h-4 animate-spin" />
      {{ lazyStrings.opfsEncryption__encryption_transition_must_finish_before_changing_this_setting() }}
    </div>

    <div v-else-if="inspection.type === 'recovery_required'" tw-class="rounded-xl bg-red-50 dark:bg-red-950/20 border border-red-100 dark:border-red-900/50 px-3.5 py-2.5 text-xs text-red-700 dark:text-red-300 flex items-start gap-2">
      <ShieldAlertIcon tw-class="w-4 h-4 shrink-0 mt-0.5" />
      {{ lazyStrings.opfsEncryption__encryption_control_state_cannot_be_read_safely() }}
    </div>

    <p v-if="errorMessage" tw-class="text-xs text-red-600 dark:text-red-400 break-words">
      {{ errorMessage }}
    </p>

    <div v-if="available" tw-class="flex flex-wrap gap-2 pt-1">
      <button
        v-if="enabled"
        type="button"
        :disabled="loading"
        tw-class="inline-flex items-center gap-2 rounded-xl border border-gray-200 dark:border-gray-700 px-3.5 py-2 text-xs font-bold text-gray-600 dark:text-gray-300 hover:bg-white dark:hover:bg-gray-800 disabled:opacity-50"
        data-testid="opfs-encryption-change-passphrase"
        @click="passphraseChangeOpen = true"
      >
        <KeyRoundIcon tw-class="w-3.5 h-3.5" />
        {{ lazyStrings.opfsEncryption__change_passphrase() }}
      </button>
      <button
        v-if="enabled"
        type="button"
        :disabled="loading"
        tw-class="inline-flex items-center gap-2 rounded-xl border border-gray-200 dark:border-gray-700 px-3.5 py-2 text-xs font-bold text-gray-600 dark:text-gray-300 hover:bg-white dark:hover:bg-gray-800 disabled:opacity-50"
        data-testid="opfs-encryption-reencrypt"
        @click="reencrypt"
      >
        <RefreshCwIcon tw-class="w-3.5 h-3.5" />
        {{ lazyStrings.opfsEncryption__re_encrypt() }}
      </button>
      <button
        type="button"
        tw-class="inline-flex items-center gap-2 rounded-xl border border-gray-200 dark:border-gray-700 px-3.5 py-2 text-xs font-bold text-gray-600 dark:text-gray-300 hover:bg-white dark:hover:bg-gray-800"
        @click="recoverySourceOpen = !recoverySourceOpen"
      >
        <KeyRoundIcon tw-class="w-3.5 h-3.5" />
        {{ lazyStrings.opfsEncryption__recovery_source() }}
      </button>
    </div>

    <OpfsEncryptionRecoverySourceViewer v-if="recoverySourceOpen" />
  </div>

  <Teleport to="body">
    <div v-if="setupOpen" data-testid="opfs-encryption-setup-dialog" tw-class="fixed inset-0 z-[110] overflow-y-auto bg-gray-950/60 backdrop-blur-sm flex items-center justify-center p-4" @click.self="resetSetup">
      <section tw-class="my-auto w-full max-w-lg max-h-[calc(100dvh-2rem)] rounded-[2rem] bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 shadow-2xl overflow-hidden flex flex-col">
        <header tw-class="shrink-0 px-7 py-6 border-b border-gray-100 dark:border-gray-800">
          <h2 tw-class="text-lg font-extrabold text-gray-900 dark:text-white">{{ lazyStrings.opfsEncryption__enable_opfs_encryption() }}</h2>
          <p tw-class="mt-1 text-xs leading-relaxed text-gray-500 dark:text-gray-400">
            {{ lazyStrings.opfsEncryption__build_and_verify_separate_encrypted_store() }}
          </p>
        </header>
        <div tw-class="min-h-0 overflow-y-auto px-7 py-6 space-y-4">
          <div tw-class="rounded-2xl bg-amber-50 dark:bg-amber-950/20 border border-amber-100 dark:border-amber-900/50 p-4 text-xs leading-relaxed text-amber-900 dark:text-amber-300 flex gap-2.5">
            <AlertTriangleIcon tw-class="w-4 h-4 shrink-0 mt-0.5" />
            <span>{{ lazyStrings.opfsEncryption__experimental_format_may_change_incompatibly() }}</span>
          </div>
          <label tw-class="block space-y-1.5">
            <span tw-class="text-xs font-bold text-gray-600 dark:text-gray-300">{{ lazyStrings.opfsEncryption__passphrase() }}</span>
            <div tw-class="relative">
              <input v-model="passphrase" data-testid="opfs-encryption-passphrase" :type="showPassphrase ? 'text' : 'password'" autocomplete="new-password" tw-class="w-full rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-950 pl-4 pr-12 py-3 text-sm outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-500" @paste="rejectLineBreakPaste({ event: $event })" />
              <button type="button" data-testid="opfs-encryption-passphrase-visibility" tw-class="absolute right-2 top-1/2 -translate-y-1/2 p-2 rounded-lg text-gray-400 hover:text-gray-700 dark:hover:text-gray-200" :title="showPassphrase ? lazyStrings.opfsEncryption__hide_passphrase() : lazyStrings.opfsEncryption__show_passphrase()" @click="showPassphrase = !showPassphrase">
                <EyeOffIcon v-if="showPassphrase" tw-class="w-4 h-4" />
                <EyeIcon v-else tw-class="w-4 h-4" />
              </button>
            </div>
          </label>
          <p v-if="boundaryWhitespaceWarning" tw-class="text-xs text-amber-700 dark:text-amber-400">
            {{ lazyStrings.opfsEncryption__leading_or_trailing_whitespace_is_part_of_passphrase() }}
          </p>
          <p v-if="passphraseValidation.type === 'line_break'" tw-class="text-xs text-red-600 dark:text-red-400">
            {{ lazyStrings.opfsEncryption__passphrases_cannot_contain_line_breaks() }}
          </p>
          <label tw-class="block space-y-1.5">
            <span tw-class="text-xs font-bold text-gray-600 dark:text-gray-300">{{ lazyStrings.opfsEncryption__confirm_passphrase() }}</span>
            <div tw-class="relative">
              <input v-model="confirmPassphrase" data-testid="opfs-encryption-passphrase-confirmation" :type="showConfirmPassphrase ? 'text' : 'password'" autocomplete="new-password" tw-class="w-full rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-950 pl-4 pr-12 py-3 text-sm outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-500" @paste="rejectLineBreakPaste({ event: $event })" />
              <button type="button" data-testid="opfs-encryption-passphrase-confirmation-visibility" tw-class="absolute right-2 top-1/2 -translate-y-1/2 p-2 rounded-lg text-gray-400 hover:text-gray-700 dark:hover:text-gray-200" :title="showConfirmPassphrase ? lazyStrings.opfsEncryption__hide_passphrase() : lazyStrings.opfsEncryption__show_passphrase()" @click="showConfirmPassphrase = !showConfirmPassphrase">
                <EyeOffIcon v-if="showConfirmPassphrase" tw-class="w-4 h-4" />
                <EyeIcon v-else tw-class="w-4 h-4" />
              </button>
            </div>
          </label>
          <p v-if="confirmPassphraseValidation.type === 'line_break'" tw-class="text-xs text-red-600 dark:text-red-400">{{ lazyStrings.opfsEncryption__passphrases_cannot_contain_line_breaks() }}</p>
          <p v-else-if="confirmPassphrase.length > 0 && passphrase !== confirmPassphrase" tw-class="text-xs text-red-600 dark:text-red-400">{{ lazyStrings.opfsEncryption__passphrases_do_not_match() }}</p>
          <label tw-class="flex items-start gap-3 cursor-pointer rounded-xl border border-gray-100 dark:border-gray-800 p-3">
            <input v-model="experimentalAccepted" data-testid="opfs-encryption-experimental-accepted" type="checkbox" tw-class="mt-0.5" />
            <span tw-class="text-xs leading-relaxed text-gray-600 dark:text-gray-300">{{ lazyStrings.opfsEncryption__understand_experimental_storage_risk() }}</span>
          </label>
          <p v-if="errorMessage" tw-class="text-xs text-red-600 dark:text-red-400 break-words">{{ errorMessage }}</p>
        </div>
        <footer tw-class="shrink-0 px-7 py-5 border-t border-gray-100 dark:border-gray-800 flex justify-end gap-3">
          <button type="button" tw-class="px-4 py-2.5 rounded-xl text-xs font-bold text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800" @click="resetSetup">{{ lazyStrings.opfsEncryption__cancel() }}</button>
          <button type="button" data-testid="opfs-encryption-enable" :disabled="!setupCanSubmit" tw-class="px-5 py-2.5 rounded-xl text-xs font-bold bg-blue-600 hover:bg-blue-700 disabled:bg-gray-300 dark:disabled:bg-gray-700 text-white flex items-center gap-2" @click="enableEncryption">
            <Loader2Icon v-if="loading" tw-class="w-4 h-4 animate-spin" />
            {{ lazyStrings.opfsEncryption__encrypt_storage() }}
          </button>
        </footer>
      </section>
    </div>

  </Teleport>

  <Teleport to="body">
    <div v-if="passphraseChangeOpen" data-testid="opfs-encryption-passphrase-change-dialog" tw-class="fixed inset-0 z-[112] overflow-y-auto bg-gray-950/60 backdrop-blur-sm flex items-center justify-center p-4" @click.self="resetPassphraseChange">
      <section tw-class="my-auto w-full max-w-lg max-h-[calc(100dvh-2rem)] rounded-[2rem] bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 shadow-2xl overflow-hidden flex flex-col">
        <header tw-class="shrink-0 px-7 py-6 border-b border-gray-100 dark:border-gray-800">
          <h2 tw-class="text-lg font-extrabold text-gray-900 dark:text-white">{{ lazyStrings.opfsEncryption__change_opfs_passphrase() }}</h2>
          <p tw-class="mt-1 text-xs leading-relaxed text-gray-500 dark:text-gray-400">
            {{ lazyStrings.opfsEncryption__only_passphrase_keyslot_is_replaced() }}
          </p>
        </header>
        <div tw-class="min-h-0 overflow-y-auto px-7 py-6 space-y-4">
          <label tw-class="block space-y-1.5">
            <span tw-class="text-xs font-bold text-gray-600 dark:text-gray-300">{{ lazyStrings.opfsEncryption__new_passphrase() }}</span>
            <div tw-class="relative">
              <input v-model="newPassphrase" data-testid="opfs-encryption-new-passphrase" :type="showNewPassphrase ? 'text' : 'password'" autocomplete="new-password" tw-class="w-full rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-950 pl-4 pr-12 py-3 text-sm outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-500" @paste="rejectLineBreakPaste({ event: $event })" />
              <button type="button" data-testid="opfs-encryption-new-passphrase-visibility" tw-class="absolute right-2 top-1/2 -translate-y-1/2 p-2 rounded-lg text-gray-400 hover:text-gray-700 dark:hover:text-gray-200" :title="showNewPassphrase ? lazyStrings.opfsEncryption__hide_passphrase() : lazyStrings.opfsEncryption__show_passphrase()" @click="showNewPassphrase = !showNewPassphrase">
                <EyeOffIcon v-if="showNewPassphrase" tw-class="w-4 h-4" />
                <EyeIcon v-else tw-class="w-4 h-4" />
              </button>
            </div>
          </label>
          <p v-if="newPassphraseValidation.type === 'boundary_whitespace'" tw-class="text-xs text-amber-700 dark:text-amber-400">
            {{ lazyStrings.opfsEncryption__leading_or_trailing_whitespace_is_part_of_passphrase() }}
          </p>
          <p v-if="newPassphraseValidation.type === 'line_break'" tw-class="text-xs text-red-600 dark:text-red-400">{{ lazyStrings.opfsEncryption__passphrases_cannot_contain_line_breaks() }}</p>
          <label tw-class="block space-y-1.5">
            <span tw-class="text-xs font-bold text-gray-600 dark:text-gray-300">{{ lazyStrings.opfsEncryption__confirm_new_passphrase() }}</span>
            <div tw-class="relative">
              <input v-model="confirmNewPassphrase" data-testid="opfs-encryption-new-passphrase-confirmation" :type="showConfirmNewPassphrase ? 'text' : 'password'" autocomplete="new-password" tw-class="w-full rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-950 pl-4 pr-12 py-3 text-sm outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-500" @paste="rejectLineBreakPaste({ event: $event })" />
              <button type="button" data-testid="opfs-encryption-new-passphrase-confirmation-visibility" tw-class="absolute right-2 top-1/2 -translate-y-1/2 p-2 rounded-lg text-gray-400 hover:text-gray-700 dark:hover:text-gray-200" :title="showConfirmNewPassphrase ? lazyStrings.opfsEncryption__hide_passphrase() : lazyStrings.opfsEncryption__show_passphrase()" @click="showConfirmNewPassphrase = !showConfirmNewPassphrase">
                <EyeOffIcon v-if="showConfirmNewPassphrase" tw-class="w-4 h-4" />
                <EyeIcon v-else tw-class="w-4 h-4" />
              </button>
            </div>
          </label>
          <p v-if="confirmNewPassphraseValidation.type === 'line_break'" tw-class="text-xs text-red-600 dark:text-red-400">{{ lazyStrings.opfsEncryption__passphrases_cannot_contain_line_breaks() }}</p>
          <p v-else-if="confirmNewPassphrase.length > 0 && newPassphrase !== confirmNewPassphrase" tw-class="text-xs text-red-600 dark:text-red-400">{{ lazyStrings.opfsEncryption__passphrases_do_not_match() }}</p>
          <p v-if="errorMessage" tw-class="text-xs text-red-600 dark:text-red-400 break-words">{{ errorMessage }}</p>
        </div>
        <footer tw-class="shrink-0 px-7 py-5 border-t border-gray-100 dark:border-gray-800 flex justify-end gap-3">
          <button type="button" tw-class="px-4 py-2.5 rounded-xl text-xs font-bold text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800" @click="resetPassphraseChange">{{ lazyStrings.opfsEncryption__cancel() }}</button>
          <button type="button" data-testid="opfs-encryption-change-passphrase-submit" :disabled="!passphraseChangeCanSubmit" tw-class="px-5 py-2.5 rounded-xl text-xs font-bold bg-blue-600 hover:bg-blue-700 disabled:bg-gray-300 dark:disabled:bg-gray-700 text-white flex items-center gap-2" @click="changePassphrase">
            <Loader2Icon v-if="loading" tw-class="w-4 h-4 animate-spin" />
            {{ lazyStrings.opfsEncryption__change_passphrase() }}
          </button>
        </footer>
      </section>
    </div>

  </Teleport>
</template>
