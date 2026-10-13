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
  <div
    lang="en"
    aria-hidden="true"
  >
    <div
      aria-label="ブラウザ内でのテキスト・画像・音声生成を表すコンセプト図"
      class="hero-visual"
    >
      <div class="browser-frame">
        <div class="browser-top">
          <div
            aria-hidden="true"
            class="browser-dots"
          ><span></span><span></span><span></span></div>
          <div class="address-bar">Naidan / on-device AI</div><svg class="icon sm">
            <use href="#i-grid"></use>
          </svg>
        </div>
        <div class="window-content">
          <div class="window-meta">
            <div class="window-caption"><svg
              aria-hidden="true"
              class="minilogo"
              fill="none"
              viewbox="0 0 24 24"
            >
              <path
                d="M5 8V6a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v2M5 16v2a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-2"
                stroke="#79b9ff"
                stroke-linecap="round"
                stroke-width="2.5"
              ></path>
              <rect
                fill="#5797f8"
                height="6"
                rx="2"
                width="6"
                x="9"
                y="9"
              ></rect>
            </svg> IN-BROWSER MODEL</div><span class="window-status">ON DEVICE</span>
          </div>
          <div class="window-card">
            <div class="window-card-head"><span>TEXT GENERATION</span><span class="type">IN BROWSER</span></div>
            <div class="chat-prompt">Where is this text processed?</div>
            <div class="chat-response"><span class="response-mark"><svg
                                         fill="none"
                                         viewbox="0 0 24 24"
                                       >
                                         <rect
                                           fill="#c5e4ff"
                                           height="7"
                                           rx="2"
                                           width="7"
                                           x="8.5"
                                           y="8.5"
                                         ></rect>
                                         <path
                                           d="M5 7V6a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v1M5 17v1a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-1"
                                           stroke="#c5e4ff"
                                           stroke-linecap="round"
                                           stroke-width="2.2"
                                         ></path>
                                       </svg></span>
              <p><strong>Naidan</strong>The model runs in this browser. No remote inference server needed.</p>
            </div>
          </div>
          <div class="window-duo">
            <div class="mini-card">
              <div class="image-art"></div>
              <div class="mini-top"><span>IMAGE GENERATION</span><span class="mini-label">IMAGE</span></div>
            </div>
            <div class="mini-card mini-audio">
              <div class="mini-top"><span>AUDIO GENERATION</span><span class="mini-label">AUDIO</span></div>
              <div
                aria-hidden="true"
                class="wave"
              ><i style="--h:10px;--o:.65"></i><i style="--h:18px"></i><i style="--h:30px"></i><i
                style="--h:15px"
              ></i><i style="--h:36px"></i><i style="--h:24px"></i><i style="--h:41px"></i><i
                style="--h:20px"></i><i style="--h:34px"></i><i style="--h:14px"></i><i
                style="--h:25px"></i><i style="--h:16px"></i><i style="--h:29px"></i><i
                style="--h:9px;--o:.7"></i></div><span class="audio-sub">SPEECH OUTPUT</span>
            </div>
          </div>
        </div>
      </div>
      <p class="visual-description">※ 英語UIを想定したコンセプト図です。実アプリの画面ではありません。</p>
    </div>
  </div>
</template>
