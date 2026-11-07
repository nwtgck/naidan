<script setup lang="ts">
import type { WorkflowConnectionReview } from '@/features/workflow/logic/model-permissions';
import { lazyStrings } from '@/strings';
defineProps<{ review: WorkflowConnectionReview }>();
defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>
<template>
  <div data-testid="workflow-connection-details" tw-class="space-y-3 text-sm">
    <dl tw-class="space-y-2">
      <div><dt tw-class="font-semibold">{{ lazyStrings.workflow__endpoint() }}</dt><dd tw-class="whitespace-pre-wrap break-all"><bdi>{{ review.endpoint }}</bdi></dd></div>
      <div><dt tw-class="font-semibold">{{ lazyStrings.workflow__model_id() }}</dt><dd tw-class="whitespace-pre-wrap break-all"><bdi>{{ review.modelId }}</bdi></dd></div>
      <div v-if="review.headerNames.length"><dt tw-class="font-semibold">{{ lazyStrings.workflow__header_names_values_hidden() }}</dt><dd v-for="(name, index) in review.headerNames" :key="index" tw-class="whitespace-pre-wrap break-all"><bdi>{{ name }}</bdi></dd></div>
    </dl>
    <p data-testid="workflow-connection-sources">{{ lazyStrings.workflow__value_sources({ sources: review.sources }) }}</p>
    <p>{{ review.scope === 'editing_session' ? lazyStrings.workflow__fixed_connection_review_scope() : lazyStrings.workflow__dynamic_connection_review_scope() }}</p>
  </div>
</template>
