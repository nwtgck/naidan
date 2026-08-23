<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import {
  AlertTriangleIcon,
  FileIcon,
  FolderIcon,
  FolderOpenIcon,
  EyeIcon,
  EyeOffIcon,
  KeyRoundIcon,
  Loader2Icon,
  LockKeyholeIcon,
  RefreshCwIcon,
  ShieldAlertIcon,
} from 'lucide-vue-next';
import { storageService } from '@/00-storage/service';
import type { OpfsEncryptionSettingsInspection } from '@/00-storage/service/naidan-opfs/persistence-runtime-contract';
import { validateEncryptionPassphrase } from '@/00-storage/service/naidan-opfs/passphrase';
import { useConfirm } from '@/composables/useConfirm';
import { useOpfsEncryptionTransition } from '@/features/opfs-encryption/composables/useOpfsEncryptionTransition';
import { ensureStrings, lazyStrings } from '@/strings';
import type { OpfsEncryptionDisableConflict } from '@/00-storage/service/naidan-opfs/native-plain-disable-conflict';
import { useFileExplorerModal } from '@/features/file-explorer/composables/useFileExplorerModal';


const props = defineProps<{
  storageType: 'local' | 'opfs' | 'memory',
}>();

const { showConfirm } = useConfirm();
const { openFileExplorer } = useFileExplorerModal();
const {
  beginLocalOperation,
  updateProgress,
  finishLocalOperation,
} = useOpfsEncryptionTransition();
const inspection = ref<OpfsEncryptionSettingsInspection>({ type: 'plain' });
const loading = ref(false);
const setupOpen = ref(false);
const passphraseChangeOpen = ref(false);
const reencryptOpen = ref(false);
const passphrase = ref('');
const confirmPassphrase = ref('');
const newPassphrase = ref('');
const reencryptPassphrase = ref('');
const confirmNewPassphrase = ref('');
const showPassphrase = ref(false);
const showConfirmPassphrase = ref(false);
const showNewPassphrase = ref(false);
const showReencryptPassphrase = ref(false);
const showConfirmNewPassphrase = ref(false);
const errorMessage = ref<string>();
const experimentalAccepted = ref(false);
const disableConflict = ref<OpfsEncryptionDisableConflict>();
const disableConflictDialogOpen = ref(false);

const available = computed(() => props.storageType === 'opfs');
const toggleChecked = computed(() => inspection.value.type === 'encrypted');
const isUnlockedEncrypted = computed(() => (
  inspection.value.type === 'encrypted' && inspection.value.access === 'unlocked'
));
const operationLocked = computed(() => {
  const currentInspection = inspection.value;
  switch (currentInspection.type) {
  case 'plain': return false;
  case 'encrypted': return currentInspection.access === 'locked';
  case 'transitioning':
  case 'recovery_required': return true;
  default: return currentInspection satisfies never;
  }
});
const passphraseValidation = computed(() => validateEncryptionPassphrase({
  passphrase: passphrase.value,
}));
const boundaryWhitespaceWarning = computed(() => (
  passphraseValidation.value.type === 'boundary_whitespace'
));
const confirmPassphraseValidation = computed(() => validateEncryptionPassphrase({
  passphrase: confirmPassphrase.value,
}));
const reencryptPassphraseValidation = computed(() => validateEncryptionPassphrase({
  passphrase: reencryptPassphrase.value,
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
const reencryptCanSubmit = computed(() => (
  reencryptPassphrase.value.length > 0
  && reencryptPassphraseValidation.value.type !== 'line_break'
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
    const nextInspection = await storageService.inspectOpfsEncryptionSettings();
    inspection.value = nextInspection;
    if (nextInspection.type !== 'encrypted' || nextInspection.access !== 'unlocked') {
      disableConflict.value = undefined;
      disableConflictDialogOpen.value = false;
    }
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

function resetReencrypt(): void {
  reencryptOpen.value = false;
  reencryptPassphrase.value = '';
  showReencryptPassphrase.value = false;
  errorMessage.value = undefined;
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

async function confirmOrdinaryDisable(): Promise<boolean> {
  return await showConfirm({
    title: await ensureStrings.opfsEncryption__turn_off_opfs_encryption(),
    message: await ensureStrings.opfsEncryption__decrypt_storage_explanation(),
    confirmButtonText: await ensureStrings.opfsEncryption__decrypt_storage(),
    confirmButtonVariant: 'danger',
  });
}

async function runDisableTransition(): Promise<void> {
  loading.value = true;
  errorMessage.value = undefined;
  beginLocalOperation();
  try {
    await storageService.disableOpfsEncryption({
      signal: undefined,
      onProgress: updateProgress,
    });
  } catch {
    // StorageService has already notified the central failure reload guard.
  } finally {
    finishLocalOperation({ outcome: 'settled_for_reload' });
    loading.value = false;
  }
}

async function handleToggle(): Promise<void> {
  if (!available.value || loading.value || operationLocked.value) return;
  if (!toggleChecked.value) {
    setupOpen.value = true;
    return;
  }

  loading.value = true;
  errorMessage.value = undefined;
  try {
    const preflight = await storageService.inspectOpfsEncryptionDisableConflict();
    switch (preflight.type) {
    case 'clear': {
      disableConflict.value = undefined;
      loading.value = false;
      if (await confirmOrdinaryDisable()) await runDisableTransition();
      return;
    }
    case 'conflict':
      disableConflict.value = preflight;
      disableConflictDialogOpen.value = true;
      return;
    default: return preflight satisfies never;
    }
  } catch (error: unknown) {
    errorMessage.value = error instanceof Error ? error.message : String(error);
  } finally {
    loading.value = false;
  }
}

function openRawOpfsExplorer(): void {
  disableConflictDialogOpen.value = false;
  openFileExplorer({ options: { kind: 'opfs-root' } });
}

async function cleanupConflictAndRetry(): Promise<void> {
  const conflict = disableConflict.value;
  if (conflict === undefined || loading.value) return;
  const confirmed = await showConfirm({
    title: await ensureStrings.OpfsEncryptionSettingsPanel__delete_conflicting_data_and_retry(),
    message: `${await ensureStrings.OpfsEncryptionSettingsPanel__plain_target_conflict_loss_warning()}\n\n${await ensureStrings.OpfsEncryptionSettingsPanel__encrypted_source_remains_authoritative()}`,
    confirmButtonText: await ensureStrings.OpfsEncryptionSettingsPanel__delete_conflicting_data_and_retry(),
    confirmButtonVariant: 'danger',
  });
  if (!confirmed) return;

  loading.value = true;
  errorMessage.value = undefined;
  try {
    const result = await storageService.cleanupOpfsEncryptionDisableConflict({
      inspectionId: conflict.inspectionId,
    });
    switch (result.type) {
    case 'clear':
      disableConflict.value = undefined;
      disableConflictDialogOpen.value = false;
      loading.value = false;
      await runDisableTransition();
      return;
    case 'conflict':
      disableConflict.value = result;
      errorMessage.value = await ensureStrings.OpfsEncryptionSettingsPanel__conflict_changed();
      return;
    default: return result satisfies never;
    }
  } catch (error: unknown) {
    errorMessage.value = error instanceof Error ? error.message : String(error);
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
    await storageService.enableOpfsEncryption({
      passphrase: passphrase.value,
      signal: undefined,
      onProgress: updateProgress,
    });
  } catch {
    // StorageService has already notified the central failure reload guard.
  } finally {
    finishLocalOperation({ outcome: 'settled_for_reload' });
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
  if (!isUnlockedEncrypted.value || !reencryptCanSubmit.value) {
    return;
  }
  loading.value = true;
  errorMessage.value = undefined;
  beginLocalOperation();
  try {
    await storageService.reencryptOpfsEncryption({
      passphrase: reencryptPassphrase.value,
      signal: undefined,
      onProgress: updateProgress,
    });
  } catch {
    // StorageService has already notified the central failure reload guard.
  } finally {
    finishLocalOperation({ outcome: 'settled_for_reload' });
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
      cleanupConflictAndRetry,
    },
  }) || {}),
});
</script>

<template>
  <div tw-class="rounded-3xl border border-gray-100 dark:border-gray-800 bg-gray-50/50 dark:bg-gray-800/30 p-5 sm:p-6 shadow-sm space-y-4">
    <div tw-class="flex items-start justify-between gap-5">
      <div tw-class="flex items-start gap-3 min-w-0">
        <div tw-class="mt-0.5 w-9 h-9 rounded-xl flex items-center justify-center" :class="toggleChecked ? 'bg-blue-100 dark:bg-blue-950/50 text-blue-600 dark:text-blue-400' : 'bg-gray-100 dark:bg-gray-800 text-gray-400'">
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
        :aria-checked="toggleChecked"
        :disabled="!available || loading || operationLocked"
        data-testid="opfs-encryption-toggle"
        tw-class="relative inline-flex shrink-0 w-12 h-7 items-center rounded-full transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        :class="toggleChecked ? 'bg-blue-600' : 'bg-gray-300 dark:bg-gray-700'"
        @click="handleToggle"
      >
        <span
          tw-class="block w-5 h-5 rounded-full bg-white shadow transition-transform"
          :class="toggleChecked ? 'translate-x-6' : 'translate-x-1'"
        />
      </button>
    </div>

    <div v-if="!available" tw-class="rounded-xl bg-gray-100/80 dark:bg-gray-900/60 px-3.5 py-2.5 text-xs text-gray-500 dark:text-gray-400">
      {{ lazyStrings.opfsEncryption__select_opfs_as_active_storage_to_enable_encryption() }}
    </div>

    <div v-else-if="inspection.type === 'encrypted' && inspection.access === 'locked'" tw-class="rounded-xl bg-amber-50 dark:bg-amber-950/20 border border-amber-100 dark:border-amber-900/50 px-3.5 py-2.5 text-xs text-amber-800 dark:text-amber-300 flex items-center gap-2">
      <KeyRoundIcon tw-class="w-4 h-4 shrink-0" />
      {{ lazyStrings.opfsEncryption__enter_passphrase_for_opfs_storage() }}
    </div>

    <div v-else-if="inspection.type === 'transitioning'" tw-class="rounded-xl bg-amber-50 dark:bg-amber-950/20 border border-amber-100 dark:border-amber-900/50 px-3.5 py-2.5 text-xs text-amber-800 dark:text-amber-300 flex items-center gap-2">
      <Loader2Icon tw-class="w-4 h-4 animate-spin" />
      {{ lazyStrings.opfsEncryption__encryption_transition_must_finish_before_changing_this_setting() }}
    </div>

    <div v-else-if="inspection.type === 'recovery_required'" tw-class="rounded-xl bg-red-50 dark:bg-red-950/20 border border-red-100 dark:border-red-900/50 px-3.5 py-2.5 text-xs text-red-700 dark:text-red-300 flex items-start gap-2">
      <ShieldAlertIcon tw-class="w-4 h-4 shrink-0 mt-0.5" />
      {{ lazyStrings.opfsEncryption__encryption_control_state_cannot_be_read_safely() }}
    </div>

    <button
      v-if="disableConflict !== undefined && !disableConflictDialogOpen"
      type="button"
      data-testid="opfs-encryption-disable-conflict-review"
      tw-class="flex w-full items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-left text-xs text-amber-900 hover:bg-amber-100 dark:border-amber-900/60 dark:bg-amber-950/20 dark:text-amber-200 dark:hover:bg-amber-950/35"
      @click="disableConflictDialogOpen = true"
    >
      <AlertTriangleIcon tw-class="mt-0.5 h-4 w-4 shrink-0" />
      <span>{{ lazyStrings.OpfsEncryptionSettingsPanel__plain_target_conflict() }}</span>
    </button>

    <p v-if="errorMessage" tw-class="text-xs text-red-600 dark:text-red-400 break-words">
      {{ errorMessage }}
    </p>

    <div v-if="available" tw-class="flex flex-wrap gap-2 pt-1">
      <button
        v-if="isUnlockedEncrypted"
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
        v-if="isUnlockedEncrypted"
        type="button"
        :disabled="loading"
        tw-class="inline-flex items-center gap-2 rounded-xl border border-gray-200 dark:border-gray-700 px-3.5 py-2 text-xs font-bold text-gray-600 dark:text-gray-300 hover:bg-white dark:hover:bg-gray-800 disabled:opacity-50"
        data-testid="opfs-encryption-reencrypt"
        @click="reencryptOpen = true"
      >
        <RefreshCwIcon tw-class="w-3.5 h-3.5" />
        {{ lazyStrings.opfsEncryption__re_encrypt() }}
      </button>
    </div>

  </div>

  <Teleport to="body">
    <div v-if="disableConflict !== undefined && disableConflictDialogOpen" data-testid="opfs-encryption-disable-conflict-dialog" tw-class="fixed inset-0 z-[112] overflow-y-auto bg-gray-950/60 backdrop-blur-sm flex items-center justify-center p-4" @click.self="disableConflictDialogOpen = false">
      <section role="dialog" aria-modal="true" aria-labelledby="opfs-encryption-disable-conflict-title" tw-class="my-auto flex max-h-[calc(100dvh-2rem)] w-full max-w-xl flex-col overflow-hidden rounded-[2rem] border border-gray-200 bg-white shadow-2xl dark:border-gray-800 dark:bg-gray-900">
        <header tw-class="shrink-0 border-b border-gray-100 px-7 py-6 dark:border-gray-800">
          <h2 id="opfs-encryption-disable-conflict-title" tw-class="flex items-center gap-2 text-lg font-extrabold text-gray-900 dark:text-white">
            <AlertTriangleIcon tw-class="h-5 w-5 shrink-0 text-amber-600" />
            {{ lazyStrings.OpfsEncryptionSettingsPanel__plain_target_conflict() }}
          </h2>
          <p tw-class="mt-2 text-xs leading-relaxed text-gray-600 dark:text-gray-300">
            {{ lazyStrings.OpfsEncryptionSettingsPanel__plain_target_conflict_explanation() }}
          </p>
        </header>
        <div tw-class="min-h-0 space-y-4 overflow-y-auto px-7 py-6">
          <ul data-testid="opfs-encryption-disable-conflict-list" tw-class="divide-y divide-gray-100 overflow-hidden rounded-xl border border-gray-200 dark:divide-gray-800 dark:border-gray-700">
            <li v-for="entry in disableConflict.entries" :key="`${entry.entryKind}:${entry.relativePath}`" tw-class="flex min-w-0 items-center gap-2 px-3 py-2 text-xs text-gray-700 dark:text-gray-200">
              <FolderIcon v-if="entry.entryKind === 'directory'" tw-class="h-4 w-4 shrink-0 text-amber-600" />
              <FileIcon v-else tw-class="h-4 w-4 shrink-0 text-gray-500" />
              <span tw-class="min-w-0 break-all font-mono">{{ entry.relativePath }}</span>
            </li>
          </ul>
          <p v-if="disableConflict.truncated" tw-class="text-xs text-gray-500 dark:text-gray-400">
            {{ lazyStrings.OpfsEncryptionSettingsPanel__additional_conflicting_entries({ count: disableConflict.totalEntryCount - disableConflict.entries.length }) }}
          </p>
          <div tw-class="space-y-2 rounded-xl border border-red-200 bg-red-50 p-3 text-xs leading-relaxed text-red-800 dark:border-red-900/60 dark:bg-red-950/20 dark:text-red-200">
            <p>{{ lazyStrings.OpfsEncryptionSettingsPanel__plain_target_conflict_loss_warning() }}</p>
            <p>{{ lazyStrings.OpfsEncryptionSettingsPanel__encrypted_source_remains_authoritative() }}</p>
          </div>
          <p v-if="errorMessage" data-testid="opfs-encryption-disable-conflict-error" tw-class="text-xs text-red-600 break-words dark:text-red-400">{{ errorMessage }}</p>
        </div>
        <footer tw-class="flex shrink-0 flex-wrap justify-end gap-2 border-t border-gray-100 px-7 py-5 dark:border-gray-800">
          <button type="button" :disabled="loading" tw-class="inline-flex items-center gap-2 rounded-xl border border-gray-200 px-3.5 py-2 text-xs font-bold text-gray-600 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800" @click="openRawOpfsExplorer">
            <FolderOpenIcon tw-class="h-4 w-4" />
            {{ lazyStrings.opfsEncryption__open_raw_opfs_explorer() }}
          </button>
          <button type="button" :disabled="loading" tw-class="rounded-xl px-3.5 py-2 text-xs font-bold text-gray-600 hover:bg-gray-100 disabled:opacity-50 dark:text-gray-300 dark:hover:bg-gray-800" @click="disableConflictDialogOpen = false">
            {{ lazyStrings.opfsEncryption__cancel() }}
          </button>
          <button type="button" data-testid="opfs-encryption-disable-conflict-cleanup" :disabled="loading" tw-class="inline-flex items-center gap-2 rounded-xl bg-red-600 px-4 py-2 text-xs font-bold text-white hover:bg-red-700 disabled:bg-gray-400" @click="cleanupConflictAndRetry">
            <Loader2Icon v-if="loading" tw-class="h-4 w-4 animate-spin" />
            {{ lazyStrings.OpfsEncryptionSettingsPanel__delete_conflicting_data_and_retry() }}
          </button>
        </footer>
      </section>
    </div>
  </Teleport>

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
    <div v-if="reencryptOpen" data-testid="opfs-encryption-reencrypt-dialog" tw-class="fixed inset-0 z-[112] overflow-y-auto bg-gray-950/60 backdrop-blur-sm flex items-center justify-center p-4" @click.self="resetReencrypt">
      <section tw-class="my-auto w-full max-w-lg max-h-[calc(100dvh-2rem)] rounded-[2rem] bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 shadow-2xl overflow-hidden flex flex-col">
        <header tw-class="shrink-0 px-7 py-6 border-b border-gray-100 dark:border-gray-800">
          <h2 tw-class="text-lg font-extrabold text-gray-900 dark:text-white">{{ lazyStrings.opfsEncryption__re_encrypt_opfs_storage() }}</h2>
        </header>
        <div tw-class="min-h-0 overflow-y-auto px-7 py-6 space-y-4">
          <div tw-class="rounded-2xl bg-amber-50 dark:bg-amber-950/20 border border-amber-100 dark:border-amber-900/50 p-4 text-xs leading-relaxed text-amber-900 dark:text-amber-300 flex gap-2.5">
            <AlertTriangleIcon tw-class="w-4 h-4 shrink-0 mt-0.5" />
            <span>{{ lazyStrings.opfsEncryption__re_encrypt_storage_explanation() }}</span>
          </div>
          <label tw-class="block space-y-1.5">
            <span tw-class="text-xs font-bold text-gray-600 dark:text-gray-300">{{ lazyStrings.opfsEncryption__passphrase() }}</span>
            <div tw-class="relative">
              <input v-model="reencryptPassphrase" data-testid="opfs-encryption-reencrypt-passphrase" :type="showReencryptPassphrase ? 'text' : 'password'" autocomplete="current-password" tw-class="w-full rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-950 pl-4 pr-12 py-3 text-sm outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-500" @paste="rejectLineBreakPaste({ event: $event })" />
              <button type="button" data-testid="opfs-encryption-reencrypt-passphrase-visibility" tw-class="absolute right-2 top-1/2 -translate-y-1/2 p-2 rounded-lg text-gray-400 hover:text-gray-700 dark:hover:text-gray-200" :title="showReencryptPassphrase ? lazyStrings.opfsEncryption__hide_passphrase() : lazyStrings.opfsEncryption__show_passphrase()" @click="showReencryptPassphrase = !showReencryptPassphrase">
                <EyeOffIcon v-if="showReencryptPassphrase" tw-class="w-4 h-4" />
                <EyeIcon v-else tw-class="w-4 h-4" />
              </button>
            </div>
          </label>
          <p v-if="reencryptPassphraseValidation.type === 'boundary_whitespace'" tw-class="text-xs text-amber-700 dark:text-amber-400">
            {{ lazyStrings.opfsEncryption__leading_or_trailing_whitespace_is_part_of_passphrase() }}
          </p>
          <p v-if="reencryptPassphraseValidation.type === 'line_break'" tw-class="text-xs text-red-600 dark:text-red-400">{{ lazyStrings.opfsEncryption__passphrases_cannot_contain_line_breaks() }}</p>
          <p v-if="errorMessage" tw-class="text-xs text-red-600 dark:text-red-400 break-words">{{ errorMessage }}</p>
        </div>
        <footer tw-class="shrink-0 px-7 py-5 border-t border-gray-100 dark:border-gray-800 flex justify-end gap-3">
          <button type="button" tw-class="px-4 py-2.5 rounded-xl text-xs font-bold text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800" @click="resetReencrypt">{{ lazyStrings.opfsEncryption__cancel() }}</button>
          <button type="button" data-testid="opfs-encryption-reencrypt-submit" :disabled="!reencryptCanSubmit" tw-class="px-5 py-2.5 rounded-xl text-xs font-bold bg-blue-600 hover:bg-blue-700 disabled:bg-gray-300 dark:disabled:bg-gray-700 text-white flex items-center gap-2" @click="reencrypt">
            <Loader2Icon v-if="loading" tw-class="w-4 h-4 animate-spin" />
            {{ lazyStrings.opfsEncryption__re_encrypt_storage() }}
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
