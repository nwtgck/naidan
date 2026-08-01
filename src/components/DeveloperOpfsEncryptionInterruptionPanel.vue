<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import {
  AlertTriangleIcon,
  EyeIcon,
  EyeOffIcon,
  Loader2Icon,
  ShieldAlertIcon,
} from 'lucide-vue-next';
import { storageService } from '@/00-storage/service';
import type { OpfsEncryptionInspection } from '@/00-storage/service/naidan-opfs/persistence-runtime-contract';
import { validateEncryptionPassphrase } from '@/00-storage/service/naidan-opfs/passphrase';
import { useConfirm } from '@/composables/useConfirm';
import { ensureStrings, lazyStrings } from '@/strings';

const props = defineProps<{
  storageType: string,
}>();

const { showConfirm } = useConfirm();
const inspection = ref<OpfsEncryptionInspection>({ type: 'plain' });
const loading = ref(false);
const passphrase = ref('');
const confirmPassphrase = ref('');
const showPassphrase = ref(false);
const errorMessage = ref<string>();

const available = computed(() => props.storageType === 'opfs');
const passphraseValidation = computed(() => validateEncryptionPassphrase({ passphrase: passphrase.value }));
const confirmPassphraseValidation = computed(() => validateEncryptionPassphrase({
  passphrase: confirmPassphrase.value,
}));
const boundaryWhitespaceWarning = computed(() => (
  passphraseValidation.value.type === 'boundary_whitespace'
  || confirmPassphraseValidation.value.type === 'boundary_whitespace'
));
const canCreateInterruptedEncryption = computed(() => (
  available.value
  && inspection.value.type === 'plain'
  && passphrase.value.length > 0
  && passphrase.value === confirmPassphrase.value
  && passphraseValidation.value.type !== 'line_break'
  && confirmPassphraseValidation.value.type !== 'line_break'
  && !loading.value
));
const canCreateInterruptedDecryption = computed(() => (
  available.value
  && inspection.value.type === 'encrypted'
  && !loading.value
));

async function refreshInspection(): Promise<void> {
  if (!available.value) {
    inspection.value = { type: 'plain' };
    return;
  }
  errorMessage.value = undefined;
  try {
    inspection.value = await storageService.inspectOpfsEncryption();
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : String(error);
  }
}

async function handlePassphrasePaste({
  event,
}: {
  event: ClipboardEvent;
}): Promise<void> {
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

async function createInterruptedEncryption(): Promise<void> {
  if (!canCreateInterruptedEncryption.value) {
    return;
  }
  const confirmed = await showConfirm({
    title: await ensureStrings.DeveloperOpfsEncryptionInterruptionPanel__create_interrupted_encryption(),
    message: await ensureStrings.DeveloperOpfsEncryptionInterruptionPanel__interrupted_encryption_warning(),
    confirmButtonText: await ensureStrings.DeveloperOpfsEncryptionInterruptionPanel__create_and_reload(),
    confirmButtonVariant: 'danger',
  });
  if (!confirmed) {
    return;
  }
  loading.value = true;
  errorMessage.value = undefined;
  try {
    await storageService.createInterruptedOpfsEncryptionForDebug({
      passphrase: passphrase.value,
      signal: undefined,
    });
    window.location.reload();
  } catch (error) {
    const operationErrorMessage = error instanceof Error ? error.message : String(error);
    await refreshInspection();
    errorMessage.value = operationErrorMessage;
  } finally {
    loading.value = false;
  }
}

async function createInterruptedDecryption(): Promise<void> {
  if (!canCreateInterruptedDecryption.value) {
    return;
  }
  const confirmed = await showConfirm({
    title: await ensureStrings.DeveloperOpfsEncryptionInterruptionPanel__create_interrupted_decryption(),
    message: await ensureStrings.DeveloperOpfsEncryptionInterruptionPanel__interrupted_decryption_warning(),
    confirmButtonText: await ensureStrings.DeveloperOpfsEncryptionInterruptionPanel__create_and_reload(),
    confirmButtonVariant: 'danger',
  });
  if (!confirmed) {
    return;
  }
  loading.value = true;
  errorMessage.value = undefined;
  try {
    await storageService.createInterruptedOpfsDecryptionForDebug({ signal: undefined });
    window.location.reload();
  } catch (error) {
    const operationErrorMessage = error instanceof Error ? error.message : String(error);
    await refreshInspection();
    errorMessage.value = operationErrorMessage;
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
      createInterruptedEncryption,
      createInterruptedDecryption,
    },
  }) || {}),
});
</script>

<template>
  <section
    data-testid="developer-opfs-encryption-interruption-panel"
    tw-class="space-y-4 rounded-2xl border border-amber-200/80 bg-amber-50/50 p-4 dark:border-amber-900/50 dark:bg-amber-950/10"
  >
    <div tw-class="flex items-start gap-3">
      <div tw-class="rounded-xl border border-amber-200 bg-white p-2 text-amber-600 shadow-sm dark:border-amber-900/60 dark:bg-gray-900 dark:text-amber-400">
        <ShieldAlertIcon tw-class="h-4 w-4" />
      </div>
      <div tw-class="space-y-1">
        <h4 tw-class="text-sm font-bold text-gray-800 dark:text-white">
          {{ lazyStrings.DeveloperOpfsEncryptionInterruptionPanel__title() }}
        </h4>
        <p tw-class="text-[11px] leading-relaxed text-gray-500 dark:text-gray-400">
          {{ lazyStrings.DeveloperOpfsEncryptionInterruptionPanel__description() }}
        </p>
      </div>
    </div>

    <div v-if="!available" tw-class="rounded-xl border border-gray-200 bg-white/70 p-3 text-xs text-gray-500 dark:border-gray-800 dark:bg-gray-900/70 dark:text-gray-400">
      {{ lazyStrings.DeveloperOpfsEncryptionInterruptionPanel__opfs_only() }}
    </div>

    <div v-else-if="inspection.type === 'transitioning'" tw-class="rounded-xl border border-amber-200 bg-white/70 p-3 text-xs text-amber-800 dark:border-amber-900/60 dark:bg-gray-900/70 dark:text-amber-300">
      {{ lazyStrings.DeveloperOpfsEncryptionInterruptionPanel__already_interrupted() }}
    </div>

    <div v-else-if="inspection.type === 'credential_required'" tw-class="rounded-xl border border-amber-200 bg-white/70 p-3 text-xs text-amber-800 dark:border-amber-900/60 dark:bg-gray-900/70 dark:text-amber-300">
      {{ lazyStrings.opfsEncryption__enter_passphrase_for_opfs_storage() }}
    </div>

    <template v-else>
      <div v-if="inspection.type === 'plain'" tw-class="space-y-3">
        <label tw-class="block text-xs font-bold text-gray-600 dark:text-gray-300">
          {{ lazyStrings.opfsEncryption__passphrase() }}
        </label>
        <div tw-class="relative">
          <input
            v-model="passphrase"
            data-testid="developer-interrupted-encryption-passphrase"
            :type="showPassphrase ? 'text' : 'password'"
            autocomplete="new-password"
            :disabled="loading"
            tw-class="w-full rounded-xl border border-gray-200 bg-white px-3 py-2.5 pr-11 text-sm text-gray-900 outline-none focus:border-amber-500 focus:ring-2 focus:ring-amber-500/20 dark:border-gray-700 dark:bg-gray-900 dark:text-white"
            @paste="handlePassphrasePaste({ event: $event })"
          />
          <button
            type="button"
            :disabled="loading"
            tw-class="absolute right-2 top-1/2 -translate-y-1/2 rounded-lg p-2 text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
            @click="showPassphrase = !showPassphrase"
          >
            <EyeOffIcon v-if="showPassphrase" tw-class="h-4 w-4" />
            <EyeIcon v-else tw-class="h-4 w-4" />
          </button>
        </div>
        <input
          v-model="confirmPassphrase"
          data-testid="developer-interrupted-encryption-confirm-passphrase"
          :type="showPassphrase ? 'text' : 'password'"
          autocomplete="new-password"
          :disabled="loading"
          :placeholder="lazyStrings.DeveloperOpfsEncryptionInterruptionPanel__confirm_passphrase()"
          tw-class="w-full rounded-xl border border-gray-200 bg-white px-3 py-2.5 text-sm text-gray-900 outline-none focus:border-amber-500 focus:ring-2 focus:ring-amber-500/20 dark:border-gray-700 dark:bg-gray-900 dark:text-white"
          @paste="handlePassphrasePaste({ event: $event })"
        />
        <p
          v-if="passphraseValidation.type === 'line_break' || confirmPassphraseValidation.type === 'line_break'"
          tw-class="text-xs text-red-600 dark:text-red-400"
        >
          {{ lazyStrings.opfsEncryption__passphrases_cannot_contain_line_breaks() }}
        </p>
        <p
          v-else-if="boundaryWhitespaceWarning"
          tw-class="text-xs text-amber-700 dark:text-amber-400"
        >
          {{ lazyStrings.opfsEncryption__leading_or_trailing_whitespace_is_part_of_passphrase() }}
        </p>
        <button
          type="button"
          data-testid="developer-create-interrupted-encryption"
          :disabled="!canCreateInterruptedEncryption"
          tw-class="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-amber-600 px-4 py-3 text-xs font-bold text-white hover:bg-amber-700 disabled:cursor-not-allowed disabled:opacity-50"
          @click="createInterruptedEncryption"
        >
          <Loader2Icon v-if="loading" tw-class="h-4 w-4 animate-spin" />
          {{ lazyStrings.DeveloperOpfsEncryptionInterruptionPanel__create_interrupted_encryption() }}
        </button>
      </div>

      <button
        v-else-if="inspection.type === 'encrypted'"
        type="button"
        data-testid="developer-create-interrupted-decryption"
        :disabled="!canCreateInterruptedDecryption"
        tw-class="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-amber-600 px-4 py-3 text-xs font-bold text-white hover:bg-amber-700 disabled:cursor-not-allowed disabled:opacity-50"
        @click="createInterruptedDecryption"
      >
        <Loader2Icon v-if="loading" tw-class="h-4 w-4 animate-spin" />
        {{ lazyStrings.DeveloperOpfsEncryptionInterruptionPanel__create_interrupted_decryption() }}
      </button>
    </template>

    <p v-if="errorMessage" tw-class="flex items-start gap-2 text-xs text-red-600 dark:text-red-400">
      <AlertTriangleIcon tw-class="mt-0.5 h-4 w-4 shrink-0" />
      <span tw-class="break-words">{{ errorMessage }}</span>
    </p>
  </section>
</template>
