<script setup lang="ts">
import { computed, defineAsyncComponent, onMounted, ref, watch } from 'vue';
import {
  AlertTriangleIcon,
  CheckIcon,
  ClipboardIcon,
  DownloadIcon,
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
const recoveryKey = ref<string>();
const copiedRecoveryKey = ref(false);
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

async function refreshInspection(): Promise<void> {
  if (!available.value) {
    inspection.value = { type: 'plain' };
    return;
  }
  loading.value = true;
  errorMessage.value = undefined;
  try {
    inspection.value = await storageService.inspectOpfsEncryption();
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : String(error);
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
    await storageService.disableOpfsEncryption({ signal: undefined });
    finishLocalOperation({ success: true });
    window.location.reload();
  } catch (error) {
    finishLocalOperation({ success: false });
    errorMessage.value = error instanceof Error ? error.message : String(error);
    await refreshInspection();
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
    const result = await storageService.enableOpfsEncryption({
      passphrase: passphrase.value,
      signal: undefined,
    });
    finishLocalOperation({ success: true });
    recoveryKey.value = result.recoveryKey;
    setupOpen.value = false;
    inspection.value = await storageService.inspectOpfsEncryption();
  } catch (error) {
    finishLocalOperation({ success: false });
    errorMessage.value = error instanceof Error ? error.message : String(error);
    await refreshInspection();
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
    await storageService.reencryptOpfsEncryption({ signal: undefined });
    finishLocalOperation({ success: true });
    window.location.reload();
  } catch (error) {
    finishLocalOperation({ success: false });
    errorMessage.value = error instanceof Error ? error.message : String(error);
    await refreshInspection();
  } finally {
    loading.value = false;
  }
}

async function copyRecoveryKey(): Promise<void> {
  if (recoveryKey.value === undefined) {
    return;
  }
  await navigator.clipboard.writeText(recoveryKey.value);
  copiedRecoveryKey.value = true;
}

function saveRecoveryKey(): void {
  if (recoveryKey.value === undefined) {
    return;
  }
  const blob = new Blob([`${recoveryKey.value}\n`], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = 'naidan-opfs-recovery-key.txt';
  anchor.click();
  URL.revokeObjectURL(url);
}

function finishRecoveryKeyStep(): void {
  recoveryKey.value = undefined;
  copiedRecoveryKey.value = false;
  resetSetup();
  window.location.reload();
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

  <div v-if="setupOpen" tw-class="fixed inset-0 z-[110] bg-gray-950/60 backdrop-blur-sm flex items-center justify-center p-4" @click.self="resetSetup">
    <section tw-class="w-full max-w-lg rounded-[2rem] bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 shadow-2xl overflow-hidden">
      <header tw-class="px-7 py-6 border-b border-gray-100 dark:border-gray-800">
        <h2 tw-class="text-lg font-extrabold text-gray-900 dark:text-white">{{ lazyStrings.opfsEncryption__enable_opfs_encryption() }}</h2>
        <p tw-class="mt-1 text-xs leading-relaxed text-gray-500 dark:text-gray-400">
          {{ lazyStrings.opfsEncryption__build_and_verify_separate_encrypted_store() }}
        </p>
      </header>
      <div tw-class="px-7 py-6 space-y-4">
        <div tw-class="rounded-2xl bg-amber-50 dark:bg-amber-950/20 border border-amber-100 dark:border-amber-900/50 p-4 text-xs leading-relaxed text-amber-900 dark:text-amber-300 flex gap-2.5">
          <AlertTriangleIcon tw-class="w-4 h-4 shrink-0 mt-0.5" />
          <span>{{ lazyStrings.opfsEncryption__experimental_format_may_change_incompatibly() }}</span>
        </div>
        <label tw-class="block space-y-1.5">
          <span tw-class="text-xs font-bold text-gray-600 dark:text-gray-300">{{ lazyStrings.opfsEncryption__passphrase() }}</span>
          <input v-model="passphrase" data-testid="opfs-encryption-passphrase" type="password" autocomplete="new-password" tw-class="w-full rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-950 px-4 py-3 text-sm outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-500" @paste="rejectLineBreakPaste({ event: $event })" />
        </label>
        <p v-if="boundaryWhitespaceWarning" tw-class="text-xs text-amber-700 dark:text-amber-400">
          {{ lazyStrings.opfsEncryption__leading_or_trailing_whitespace_is_part_of_passphrase() }}
        </p>
        <p v-if="passphraseValidation.type === 'line_break'" tw-class="text-xs text-red-600 dark:text-red-400">
          {{ lazyStrings.opfsEncryption__passphrases_cannot_contain_line_breaks() }}
        </p>
        <label tw-class="block space-y-1.5">
          <span tw-class="text-xs font-bold text-gray-600 dark:text-gray-300">{{ lazyStrings.opfsEncryption__confirm_passphrase() }}</span>
          <input v-model="confirmPassphrase" data-testid="opfs-encryption-passphrase-confirmation" type="password" autocomplete="new-password" tw-class="w-full rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-950 px-4 py-3 text-sm outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-500" @paste="rejectLineBreakPaste({ event: $event })" />
        </label>
        <p v-if="confirmPassphraseValidation.type === 'line_break'" tw-class="text-xs text-red-600 dark:text-red-400">{{ lazyStrings.opfsEncryption__passphrases_cannot_contain_line_breaks() }}</p>
        <p v-else-if="confirmPassphrase.length > 0 && passphrase !== confirmPassphrase" tw-class="text-xs text-red-600 dark:text-red-400">{{ lazyStrings.opfsEncryption__passphrases_do_not_match() }}</p>
        <label tw-class="flex items-start gap-3 cursor-pointer rounded-xl border border-gray-100 dark:border-gray-800 p-3">
          <input v-model="experimentalAccepted" data-testid="opfs-encryption-experimental-accepted" type="checkbox" tw-class="mt-0.5" />
          <span tw-class="text-xs leading-relaxed text-gray-600 dark:text-gray-300">{{ lazyStrings.opfsEncryption__understand_experimental_storage_risk() }}</span>
        </label>
        <p v-if="errorMessage" tw-class="text-xs text-red-600 dark:text-red-400 break-words">{{ errorMessage }}</p>
      </div>
      <footer tw-class="px-7 py-5 border-t border-gray-100 dark:border-gray-800 flex justify-end gap-3">
        <button type="button" tw-class="px-4 py-2.5 rounded-xl text-xs font-bold text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800" @click="resetSetup">{{ lazyStrings.opfsEncryption__cancel() }}</button>
        <button type="button" data-testid="opfs-encryption-enable" :disabled="!setupCanSubmit" tw-class="px-5 py-2.5 rounded-xl text-xs font-bold bg-blue-600 hover:bg-blue-700 disabled:bg-gray-300 dark:disabled:bg-gray-700 text-white flex items-center gap-2" @click="enableEncryption">
          <Loader2Icon v-if="loading" tw-class="w-4 h-4 animate-spin" />
          {{ lazyStrings.opfsEncryption__encrypt_storage() }}
        </button>
      </footer>
    </section>
  </div>

  <div v-if="passphraseChangeOpen" tw-class="fixed inset-0 z-[112] bg-gray-950/60 backdrop-blur-sm flex items-center justify-center p-4" @click.self="resetPassphraseChange">
    <section tw-class="w-full max-w-lg rounded-[2rem] bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 shadow-2xl overflow-hidden">
      <header tw-class="px-7 py-6 border-b border-gray-100 dark:border-gray-800">
        <h2 tw-class="text-lg font-extrabold text-gray-900 dark:text-white">{{ lazyStrings.opfsEncryption__change_opfs_passphrase() }}</h2>
        <p tw-class="mt-1 text-xs leading-relaxed text-gray-500 dark:text-gray-400">
          {{ lazyStrings.opfsEncryption__only_passphrase_keyslot_is_replaced() }}
        </p>
      </header>
      <div tw-class="px-7 py-6 space-y-4">
        <label tw-class="block space-y-1.5">
          <span tw-class="text-xs font-bold text-gray-600 dark:text-gray-300">{{ lazyStrings.opfsEncryption__new_passphrase() }}</span>
          <input v-model="newPassphrase" data-testid="opfs-encryption-new-passphrase" type="password" autocomplete="new-password" tw-class="w-full rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-950 px-4 py-3 text-sm outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-500" @paste="rejectLineBreakPaste({ event: $event })" />
        </label>
        <p v-if="newPassphraseValidation.type === 'boundary_whitespace'" tw-class="text-xs text-amber-700 dark:text-amber-400">
          {{ lazyStrings.opfsEncryption__leading_or_trailing_whitespace_is_part_of_passphrase() }}
        </p>
        <p v-if="newPassphraseValidation.type === 'line_break'" tw-class="text-xs text-red-600 dark:text-red-400">{{ lazyStrings.opfsEncryption__passphrases_cannot_contain_line_breaks() }}</p>
        <label tw-class="block space-y-1.5">
          <span tw-class="text-xs font-bold text-gray-600 dark:text-gray-300">{{ lazyStrings.opfsEncryption__confirm_new_passphrase() }}</span>
          <input v-model="confirmNewPassphrase" data-testid="opfs-encryption-new-passphrase-confirmation" type="password" autocomplete="new-password" tw-class="w-full rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-950 px-4 py-3 text-sm outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-500" @paste="rejectLineBreakPaste({ event: $event })" />
        </label>
        <p v-if="confirmNewPassphraseValidation.type === 'line_break'" tw-class="text-xs text-red-600 dark:text-red-400">{{ lazyStrings.opfsEncryption__passphrases_cannot_contain_line_breaks() }}</p>
        <p v-else-if="confirmNewPassphrase.length > 0 && newPassphrase !== confirmNewPassphrase" tw-class="text-xs text-red-600 dark:text-red-400">{{ lazyStrings.opfsEncryption__passphrases_do_not_match() }}</p>
        <p v-if="errorMessage" tw-class="text-xs text-red-600 dark:text-red-400 break-words">{{ errorMessage }}</p>
      </div>
      <footer tw-class="px-7 py-5 border-t border-gray-100 dark:border-gray-800 flex justify-end gap-3">
        <button type="button" tw-class="px-4 py-2.5 rounded-xl text-xs font-bold text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800" @click="resetPassphraseChange">{{ lazyStrings.opfsEncryption__cancel() }}</button>
        <button type="button" data-testid="opfs-encryption-change-passphrase-submit" :disabled="!passphraseChangeCanSubmit" tw-class="px-5 py-2.5 rounded-xl text-xs font-bold bg-blue-600 hover:bg-blue-700 disabled:bg-gray-300 dark:disabled:bg-gray-700 text-white flex items-center gap-2" @click="changePassphrase">
          <Loader2Icon v-if="loading" tw-class="w-4 h-4 animate-spin" />
          {{ lazyStrings.opfsEncryption__change_passphrase() }}
        </button>
      </footer>
    </section>
  </div>

  <div v-if="recoveryKey !== undefined" tw-class="fixed inset-0 z-[115] bg-gray-950/65 backdrop-blur-sm flex items-center justify-center p-4">
    <section tw-class="w-full max-w-xl rounded-[2rem] bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 shadow-2xl overflow-hidden">
      <header tw-class="px-7 py-6 border-b border-gray-100 dark:border-gray-800">
        <div tw-class="flex items-center gap-3">
          <div tw-class="w-10 h-10 rounded-xl bg-green-100 dark:bg-green-950/40 text-green-600 dark:text-green-400 flex items-center justify-center"><CheckIcon tw-class="w-5 h-5" /></div>
          <div>
            <h2 tw-class="text-lg font-extrabold text-gray-900 dark:text-white">{{ lazyStrings.opfsEncryption__encryption_enabled() }}</h2>
            <p tw-class="text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.opfsEncryption__save_recovery_key_before_continuing() }}</p>
          </div>
        </div>
      </header>
      <div tw-class="px-7 py-6 space-y-4">
        <code tw-class="block rounded-2xl bg-gray-950 text-green-300 p-4 text-xs leading-relaxed break-all select-all">{{ recoveryKey }}</code>
        <div tw-class="flex flex-wrap gap-2">
          <button type="button" tw-class="inline-flex items-center gap-2 rounded-xl border border-gray-200 dark:border-gray-700 px-4 py-2.5 text-xs font-bold" @click="copyRecoveryKey">
            <CheckIcon v-if="copiedRecoveryKey" tw-class="w-4 h-4" />
            <ClipboardIcon v-else tw-class="w-4 h-4" />
            {{ copiedRecoveryKey ? lazyStrings.opfsEncryption__copied() : lazyStrings.opfsEncryption__copy() }}
          </button>
          <button type="button" tw-class="inline-flex items-center gap-2 rounded-xl border border-gray-200 dark:border-gray-700 px-4 py-2.5 text-xs font-bold" @click="saveRecoveryKey">
            <DownloadIcon tw-class="w-4 h-4" />
            {{ lazyStrings.opfsEncryption__save_file() }}
          </button>
        </div>
        <p tw-class="text-xs leading-relaxed text-amber-700 dark:text-amber-400">{{ lazyStrings.opfsEncryption__plaintext_recovery_key_is_not_stored() }}</p>
      </div>
      <footer tw-class="px-7 py-5 border-t border-gray-100 dark:border-gray-800 flex justify-end">
        <button type="button" tw-class="px-5 py-2.5 rounded-xl text-xs font-bold bg-blue-600 hover:bg-blue-700 text-white" @click="finishRecoveryKeyStep">{{ lazyStrings.opfsEncryption__i_saved_the_recovery_key() }}</button>
      </footer>
    </section>
  </div>
</template>
