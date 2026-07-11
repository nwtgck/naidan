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
import type { OpfsEncryptionStartupGate } from '@/logic/startup/opfs-encryption-startup-gate';
import { validateEncryptionPassphrase } from '@/00-storage/service/opfs-encryption/passphrase';
import { useFileExplorerModal } from '@/features/file-explorer/composables/useFileExplorerModal';
import { ensureStrings, lazyStrings } from '@/strings';

const FileExplorerModal = defineAsyncComponent(
  () => import('@/features/file-explorer/components/FileExplorerModal.vue'),
);

const props = defineProps<{
  gate: OpfsEncryptionStartupGate,
}>();

const credentialMode = ref<'passphrase' | 'recovery_key'>('passphrase');
const credential = ref('');
const showCredential = ref(false);
const working = ref(false);
const errorMessage = ref<string>();
const { isFileExplorerOpen, openFileExplorer } = useFileExplorerModal();

const inspection = computed(() => props.gate.inspection.value);
const isRecoveryRequired = computed(() => inspection.value.type === 'recovery_required');
const isTransitioning = computed(() => inspection.value.type === 'transitioning');
const passphraseValidation = computed(() => validateEncryptionPassphrase({
  passphrase: credential.value,
}));
const boundaryWhitespaceWarning = computed(() => (
  credentialMode.value === 'passphrase'
  && passphraseValidation.value.type === 'boundary_whitespace'
));
const hasLineBreak = computed(() => (
  credentialMode.value === 'passphrase'
  && passphraseValidation.value.type === 'line_break'
));

async function submitCredential(): Promise<void> {
  if (working.value || credential.value.length === 0 || hasLineBreak.value) {
    return;
  }
  working.value = true;
  errorMessage.value = undefined;
  try {
    switch (credentialMode.value) {
    case 'passphrase':
      await props.gate.unlockWithPassphrase({ passphrase: credential.value });
      break;
    case 'recovery_key':
      await props.gate.unlockWithRecoveryKey({ recoveryKey: credential.value });
      break;
    default: {
      const _ex: never = credentialMode.value;
      throw new Error(`Unhandled credential mode: ${String(_ex)}`);
    }
    }
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : String(error);
  } finally {
    working.value = false;
  }
}

async function retryInspection(): Promise<void> {
  if (working.value) {
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

function selectCredentialMode({ mode }: { mode: 'passphrase' | 'recovery_key' }): void {
  credentialMode.value = mode;
  credential.value = '';
  errorMessage.value = undefined;
}

async function handleCredentialPaste({ event }: { event: ClipboardEvent }): Promise<void> {
  switch (credentialMode.value) {
  case 'recovery_key':
    errorMessage.value = undefined;
    return;
  case 'passphrase':
    break;
  default: {
    const _ex: never = credentialMode.value;
    throw new Error(`Unhandled credential mode: ${String(_ex)}`);
  }
  }

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
      submitCredential,
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
                {{ isRecoveryRequired ? lazyStrings.opfsEncryption__encrypted_storage_needs_recovery() : isTransitioning ? lazyStrings.opfsEncryption__finish_encrypted_storage_update() : lazyStrings.opfsEncryption__unlock_encrypted_storage() }}
              </h1>
              <span tw-class="text-[9px] px-2 py-1 rounded-full border border-amber-200 dark:border-amber-900/60 bg-amber-50 dark:bg-amber-950/30 text-amber-700 dark:text-amber-400 font-bold uppercase tracking-wider">
                {{ lazyStrings.opfsEncryption__experimental() }}
              </span>
            </div>
            <p tw-class="text-sm leading-relaxed text-gray-500 dark:text-gray-400">
              <template v-if="isRecoveryRequired">
                {{ lazyStrings.opfsEncryption__could_not_read_encryption_control_state() }}
              </template>
              <template v-else-if="isTransitioning">
                {{ lazyStrings.opfsEncryption__interrupted_encryption_operation() }}
              </template>
              <template v-else>
                {{ lazyStrings.opfsEncryption__enter_passphrase_or_recovery_key() }}
              </template>
            </p>
          </div>
        </div>
      </div>

      <div tw-class="px-7 py-7 sm:px-9 space-y-6">
        <template v-if="!isRecoveryRequired">
          <div tw-class="inline-flex p-1 rounded-xl bg-gray-100 dark:bg-gray-800">
            <button
              type="button"
              tw-class="px-4 py-2 rounded-lg text-xs font-bold transition-colors"
              :class="credentialMode === 'passphrase' ? 'bg-white dark:bg-gray-700 text-gray-900 dark:text-white shadow-sm' : 'text-gray-500 dark:text-gray-400'"
              @click="selectCredentialMode({ mode: 'passphrase' })"
            >
              {{ lazyStrings.opfsEncryption__passphrase() }}
            </button>
            <button
              type="button"
              tw-class="px-4 py-2 rounded-lg text-xs font-bold transition-colors"
              :class="credentialMode === 'recovery_key' ? 'bg-white dark:bg-gray-700 text-gray-900 dark:text-white shadow-sm' : 'text-gray-500 dark:text-gray-400'"
              @click="selectCredentialMode({ mode: 'recovery_key' })"
            >
              {{ lazyStrings.opfsEncryption__recovery_key() }}
            </button>
          </div>

          <form tw-class="space-y-3" @submit.prevent="submitCredential">
            <label tw-class="block text-xs font-bold text-gray-600 dark:text-gray-300">
              {{ credentialMode === 'passphrase' ? lazyStrings.opfsEncryption__passphrase() : lazyStrings.opfsEncryption__recovery_key() }}
            </label>
            <div tw-class="relative">
              <KeyRoundIcon tw-class="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
              <input
                v-model="credential"
                :type="showCredential ? 'text' : 'password'"
                autocomplete="current-password"
                tw-class="w-full rounded-2xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-950 pl-11 pr-12 py-3.5 text-sm text-gray-900 dark:text-white outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-500"
                @paste="handleCredentialPaste({ event: $event })"
              />
              <button
                type="button"
                tw-class="absolute right-3 top-1/2 -translate-y-1/2 p-2 rounded-lg text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
                @click="showCredential = !showCredential"
              >
                <EyeOffIcon v-if="showCredential" tw-class="w-4 h-4" />
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
            <button
              type="submit"
              :disabled="working || credential.length === 0 || hasLineBreak"
              tw-class="w-full mt-2 rounded-2xl bg-blue-600 hover:bg-blue-700 disabled:bg-gray-300 dark:disabled:bg-gray-700 text-white px-5 py-3.5 text-sm font-bold flex items-center justify-center gap-2 transition-colors"
            >
              <Loader2Icon v-if="working" tw-class="w-4 h-4 animate-spin" />
              {{ isTransitioning ? lazyStrings.opfsEncryption__unlock_and_finish() : lazyStrings.opfsEncryption__unlock_storage() }}
            </button>
          </form>
        </template>

        <div v-else tw-class="space-y-4">
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
          <div tw-class="text-xs text-gray-500 dark:text-gray-400">
            {{ isTransitioning
              ? lazyStrings.opfsEncryption__raw_opfs_access_disabled_during_transition()
              : lazyStrings.opfsEncryption__raw_opfs_access_does_not_decrypt() }}
          </div>
          <button
            v-if="!isTransitioning"
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
