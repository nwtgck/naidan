<script setup lang="ts">
import { Loader2Icon, ShieldCheckIcon } from 'lucide-vue-next';
import { lazyStrings } from '@/strings';

defineExpose({
  ...((__BUILD_MODE_IS_TEST__ && {
    TEST_ONLY: {
      // Export internal state and logic used only for testing here. Do not reference these in production logic.
    },
  }) || {}),
});
</script>

<template>
  <div
    data-testid="opfs-encryption-transition-view"
    tw-class="fixed inset-0 z-[120] bg-gray-950/70 backdrop-blur-md flex items-center justify-center p-5"
  >
    <section tw-class="w-full max-w-lg rounded-[2rem] border border-white/10 bg-white dark:bg-gray-900 shadow-2xl px-8 py-9 text-center space-y-5">
      <div tw-class="mx-auto w-14 h-14 rounded-2xl bg-blue-600 text-white flex items-center justify-center shadow-lg shadow-blue-500/30 relative">
        <ShieldCheckIcon tw-class="w-7 h-7" />
        <Loader2Icon tw-class="absolute -right-2 -bottom-2 w-6 h-6 rounded-full bg-white dark:bg-gray-900 text-blue-600 p-1 animate-spin" />
      </div>
      <div tw-class="space-y-2">
        <h2 tw-class="text-xl font-extrabold text-gray-900 dark:text-white tracking-tight">
          {{ lazyStrings.opfsEncryption__updating_encrypted_storage() }}
        </h2>
        <p tw-class="text-sm leading-relaxed text-gray-500 dark:text-gray-400">
          {{ lazyStrings.opfsEncryption__copying_and_verifying_complete_opfs_storage() }}
        </p>
      </div>
      <div tw-class="rounded-2xl bg-blue-50 dark:bg-blue-950/25 border border-blue-100 dark:border-blue-900/50 px-4 py-3 text-xs leading-relaxed text-blue-800 dark:text-blue-300">
        {{ lazyStrings.opfsEncryption__source_remains_until_verified() }}
      </div>
    </section>
  </div>
</template>
