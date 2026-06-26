<script setup lang="ts">
import { FlaskConicalIcon } from 'lucide-vue-next';
import { RouterLink } from 'vue-router';

import { DEBUG_FILE_PROTOCOL_STANDALONE_VERIFICATION_ROUTE_PATH } from '@/services/debug-file-protocol-standalone/verification/report';


defineExpose({
  TEST_ONLY: {
    // Export internal state and logic used only for testing here. Do not reference these in production logic.
    // ESLint-required for defineExpose.
  },
});
</script>

<template>
  <main class="mx-auto flex min-h-full w-full max-w-4xl flex-col gap-6 p-6 sm:p-10">
    <header class="space-y-2">
      <p class="text-sm font-medium uppercase tracking-wide text-muted-foreground">
        Debug
      </p>
      <h1 class="text-3xl font-semibold tracking-tight">
        Debug tools
      </h1>
      <p class="max-w-2xl text-sm text-muted-foreground">
        Open an isolated diagnostic page without adding Debug-only behavior to the normal application flow.
      </p>
    </header>

    <section class="grid gap-4">
      <RouterLink
        :to="DEBUG_FILE_PROTOCOL_STANDALONE_VERIFICATION_ROUTE_PATH"
        class="flex items-start gap-4 rounded-lg border bg-card p-5 text-card-foreground transition-colors hover:bg-accent"
        data-testid="standalone-verification-link"
      >
        <FlaskConicalIcon class="mt-0.5 size-5 shrink-0" />
        <span class="space-y-1">
          <span class="block font-medium">File-protocol standalone verification</span>
          <span class="block text-sm text-muted-foreground">
            Verify generated scripts, routing, lazy styles, SystemJS recovery, and the reusable Worker factory.
          </span>
        </span>
      </RouterLink>
    </section>
  </main>
</template>
