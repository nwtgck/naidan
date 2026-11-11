<script setup lang="ts">
import type { ImageGenerationSampling } from '@/01-models/image-generation-history';
import { lazyStrings } from '@/strings';

defineProps<{ sampling: ImageGenerationSampling | undefined }>();
defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>
<template>
  <section v-if="sampling" data-testid="image-sampling-receipt" tw-class="space-y-1 text-xs text-gray-500 dark:text-gray-400">
    <p>{{ lazyStrings.ImageSamplingReceipt__used_for_generation() }}</p>
    <dl tw-class="flex flex-wrap gap-x-4 gap-y-1">
      <div tw-class="flex gap-1"><dt>{{ lazyStrings.stableDiffusionCppBrowser__sampler() }}:</dt><dd data-testid="image-sampling-sampler">{{ sampling.sampler.name ?? lazyStrings.ImageSamplingReceipt__name_not_reported() }}</dd></div>
      <div tw-class="flex gap-1"><dt>{{ lazyStrings.stableDiffusionCppBrowser__scheduler() }}:</dt><dd data-testid="image-sampling-scheduler">{{ sampling.scheduler.name ?? lazyStrings.ImageSamplingReceipt__name_not_reported() }}</dd></div>
    </dl>
  </section>
</template>
