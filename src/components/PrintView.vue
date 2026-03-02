<script setup lang="ts">
/**
 * PrintView is a generic top-level container for print-only content.
 * It is hidden during normal operation. When window.print() is called,
 * its global CSS (@media print) hides the rest of the app and shows this container.
 */


defineExpose({
  __testOnly: {
    // Export internal state and logic used only for testing here. Do not reference these in production logic.
  }
});
</script>

<template>
  <!-- Added theme background classes directly to the layer to ensure color inheritance -->
  <div class="naidan-print-view-layer bg-white dark:bg-gray-950 text-gray-900 dark:text-gray-100">
    <div class="print-container">
      <slot></slot>
    </div>
  </div>
</template>

<style>
/*
  GLOBAL PRINT STYLES
*/
@media print {
  /* 1. Hide the entire main application UI (siblings of PrintView in App.vue) */
  #app > div:not(.naidan-print-view-layer) {
    display: none !important;
  }

  /* 2. Prepare html/body for full-page background printing */
  html, body {
    height: auto !important;
    overflow: visible !important;
    margin: 0 !important;
    padding: 0 !important;
    /* We must allow the background of the print-view-layer to fill the page */
    background-color: transparent !important;
  }

  /* 3. Reveal the PrintView layer and force it to fill the paper */
  .naidan-print-view-layer {
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

  /* 4. Force background for all elements within the print layer (bubbles, code, etc) */
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
/* Hidden by default in screen mode */
.naidan-print-view-layer {
  display: none;
}
</style>
