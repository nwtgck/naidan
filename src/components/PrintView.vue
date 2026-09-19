<script setup lang="ts">
/**
 * PrintView is a generic print-only container.
 *
 * The rendered layer is teleported to <body> so print visibility does not depend on
 * the internal DOM topology of #app. It stays owned by the lazy post-startup
 * auxiliary UI while being rendered outside the normal application tree.
 */


defineExpose({
  ...((__BUILD_MODE_IS_TEST__ && {
    TEST_ONLY: {
      // Export internal state and logic used only for testing here. Do not reference these in production logic.
    },
  }) || {}),
});
</script>

<template>
  <Teleport to="body">
    <!--
      Keep the layer hidden inline as well as through component CSS. This prevents a
      screen-mode flash while the async component/style chunk is being activated;
      the print-media !important rule below deliberately overrides it for printing.
    -->
    <div
      class="naidan-print-view-layer"
      style="display: none"
      tw-class="bg-white dark:bg-gray-950 text-gray-900 dark:text-gray-100"
    >
      <div class="print-container">
        <slot></slot>
      </div>
    </div>
  </Teleport>
</template>

<style>
/*
  GLOBAL PRINT STYLES
*/
@media print {
  /*
    PrintView is a direct child of body via Teleport. Hide every other application
    or overlay root so printing is independent of #app's internal DOM topology.
  */
  body > *:not(.naidan-print-view-layer) {
    display: none !important;
  }

  /* Prepare html/body for full-page background printing */
  html, body {
    height: auto !important;
    overflow: visible !important;
    margin: 0 !important;
    padding: 0 !important;
    /* We must allow the background of the print-view-layer to fill the page */
    background-color: transparent !important;
  }

  /* Reveal the teleported PrintView layer and force it to fill the paper */
  body > .naidan-print-view-layer {
    display: block !important;
    position: absolute;
    top: 0;
    left: 0;
    width: 100% !important;
    min-height: 100% !important;
    z-index: 99999;
    padding: 0 !important;
    margin: 0 !important;

    /* CRITICAL: Force the background color to be printed */
    -webkit-print-color-adjust: exact !important;
    print-color-adjust: exact !important;
    color-adjust: exact !important;
  }

  /* Force background for all elements within the print layer (bubbles, code, etc) */
  .naidan-print-view-layer * {
    -webkit-print-color-adjust: exact !important;
    print-color-adjust: exact !important;
    color-adjust: exact !important;
  }

  /* Hide UI interactions */
  .naidan-print-view-layer button,
  .naidan-print-view-layer .no-print,
  .naidan-print-view-layer .message-version-paging,
  .naidan-print-view-layer .group\/msg-header-tools,
  .naidan-print-view-layer .group\/msg-footer-tools {
    display: none !important;
  }

  .prose {
    max-width: none !important;
  }
}
</style>

<style scoped>
/* Hidden by default in screen mode. The inline style is an additional no-flash guard. */
.naidan-print-view-layer {
  display: none;
}
</style>
