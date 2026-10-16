<script setup lang="ts">
defineExpose({
  ...((__BUILD_MODE_IS_TEST__ && {
    TEST_ONLY: {
      // Export internal state and logic used only for testing here. Do not reference these in production logic.
      // ESLint-required for defineExpose.
    },
  }) || {}),
});
</script>

<template>
  <svg
    aria-hidden="true"
    class="sprite"
    xmlns="http://www.w3.org/2000/svg"
  >
    <symbol
      id="i-arrow"
      viewbox="0 0 24 24"
    >
      <path d="M5 12h14m-7-7 7 7-7 7"></path>
    </symbol>
    <symbol
      id="i-up"
      viewbox="0 0 24 24"
    >
      <path d="M7 17 17 7M7 7h10v10"></path>
    </symbol>
    <symbol
      id="i-search"
      viewbox="0 0 24 24"
    >
      <circle
        cx="10.8"
        cy="10.8"
        r="6.8"
      ></circle>
      <path d="m16 16 5 5"></path>
    </symbol>
    <symbol
      id="i-grid"
      viewbox="0 0 24 24"
    >
      <rect
        height="7"
        rx="1"
        width="7"
        x="3"
        y="3"
      ></rect>
      <rect
        height="7"
        rx="1"
        width="7"
        x="14"
        y="3"
      ></rect>
      <rect
        height="7"
        rx="1"
        width="7"
        x="3"
        y="14"
      ></rect>
      <rect
        height="7"
        rx="1"
        width="7"
        x="14"
        y="14"
      ></rect>
    </symbol>
    <symbol
      id="i-shield"
      viewbox="0 0 24 24"
    >
      <path d="m12 2 8.5 4v5.5c0 5-3.5 8.4-8.5 10.5C7 19.9 3.5 16.5 3.5 11.5V6L12 2Z"></path>
      <path d="m8.5 12 2.5 2.5 4.5-5"></path>
    </symbol>
    <symbol
      id="i-branch"
      viewbox="0 0 24 24"
    >
      <circle
        cx="6"
        cy="5"
        r="2"
      ></circle>
      <circle
        cx="18"
        cy="8"
        r="2"
      ></circle>
      <circle
        cx="18"
        cy="19"
        r="2"
      ></circle>
      <path d="M6 7v8a4 4 0 0 0 4 4h6M8 9h6a4 4 0 0 1 4-1"></path>
    </symbol>
    <symbol
      id="i-folder"
      viewbox="0 0 24 24"
    >
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"></path>
    </symbol>
    <symbol
      id="i-terminal"
      viewbox="0 0 24 24"
    >
      <rect
        height="16"
        rx="2"
        width="19"
        x="2.5"
        y="4"
      ></rect>
      <path d="m7 9 4 3-4 3m6 0h4"></path>
    </symbol>
    <symbol
      id="i-image"
      viewbox="0 0 24 24"
    >
      <rect
        height="18"
        rx="3"
        width="18"
        x="3"
        y="3"
      ></rect>
      <circle
        cx="9"
        cy="9"
        r="2"
      ></circle>
      <path d="m3.5 18 5.5-5 4 4 2-2 5.5 4"></path>
    </symbol>
    <symbol
      id="i-audio"
      viewbox="0 0 24 24"
    >
      <path d="M3 10v4m4-8v12m4-15v18m4-13v8m4-12v16m3-10v4"></path>
    </symbol>
    <symbol
      id="i-settings"
      viewbox="0 0 24 24"
    >
      <circle
        cx="12"
        cy="12"
        r="3"
      ></circle>
      <path
        d="M4 9.5 2.8 12 4 14.5l2.4.5 1.2 2.1-.7 2.4 2.7 1.5 1.7-1.7h2.4l1.7 1.7 2.7-1.5-.7-2.4 1.2-2.1 2.4-.5 1.2-2.5L20 9.5l-2.4-.5-1.2-2.1.7-2.4-2.7-1.5-1.7 1.7h-2.4L8.6 3 5.9 4.5l.7 2.4-1.2 2.1Z"
      ></path>
    </symbol>
    <symbol
      id="i-book"
      viewbox="0 0 24 24"
    >
      <path d="M12 5c-3-2-6-2.5-9-1v16c3-1.5 6-1 9 1 3-2 6-2.5 9-1V4c-3-1.5-6-1-9 1Z"></path>
      <path d="M12 5v16"></path>
    </symbol>
    <symbol
      id="i-download"
      viewbox="0 0 24 24"
    >
      <path d="M12 3v12m-4-4 4 4 4-4M4 17v3h16v-3"></path>
    </symbol>
    <symbol
      id="i-cpu"
      viewbox="0 0 24 24"
    >
      <rect
        height="12"
        rx="2"
        width="12"
        x="6"
        y="6"
      ></rect>
      <rect
        height="6"
        rx="1"
        width="6"
        x="9"
        y="9"
      ></rect>
      <path d="M9 2v4m6-4v4M9 18v4m6-4v4M2 9h4m-4 6h4m12-6h4m-4 6h4"></path>
    </symbol>
    <symbol
      id="i-model"
      viewbox="0 0 24 24"
    >
      <path d="M12 2 3 7v10l9 5 9-5V7Z"></path>
      <path d="m3 7 9 5 9-5m-9 5v10"></path>
    </symbol>
    <symbol
      id="i-moon"
      viewbox="0 0 24 24"
    >
      <path d="M20 15.8A8.7 8.7 0 0 1 8.2 4 8.8 8.8 0 1 0 20 15.8Z"></path>
    </symbol>
    <symbol
      id="i-sun"
      viewbox="0 0 24 24"
    >
      <circle
        cx="12"
        cy="12"
        r="4"
      ></circle>
      <path
        d="M12 2v2m0 16v2M2 12h2m16 0h2M4.93 4.93l1.42 1.42m11.3 11.3 1.42 1.42m0-14.14-1.42 1.42M6.35 17.65l-1.42 1.42"
      ></path>
    </symbol>
    <symbol
      id="i-globe"
      viewbox="0 0 24 24"
    >
      <circle
        cx="12"
        cy="12"
        r="9"
      ></circle>
      <path d="M3 12h18M12 3c4 5 4 13 0 18M12 3c-4 5-4 13 0 18"></path>
    </symbol>
    <symbol
      id="i-chevron"
      viewbox="0 0 24 24"
    >
      <path d="m9 6 6 6-6 6"></path>
    </symbol>
  </svg>
</template>
