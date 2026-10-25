<script setup lang="ts">
import { ArrowUpIcon, AudioLinesIcon, ChevronDownIcon, CloudIcon, DownloadIcon, PlayIcon } from 'lucide-vue-next';
import naidanLogo from '../../assets/naidan.svg';
import HomeBrowserFrame from './HomeBrowserFrame.vue';
import HomeLocalGenerationBadge from './HomeLocalGenerationBadge.vue';
import HomeTypingText from './HomeTypingText.vue';

defineProps<{ messages: typeof import('../../pages/index/messages/en').messages }>();

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <div class="speech-comparison" data-docs-animation="speech-route-comparison" data-testid="docs-speech-route-comparison">
    <section class="comparison-mode local-mode" :aria-label="messages.naidan_speech_generation">
      <div class="local-route">
        <HomeLocalGenerationBadge :claim="messages.no_text_sent_to_server" />
        <HomeBrowserFrame identity="naidan" tab-label="Naidan" class="comparison-browser" data-testid="docs-local-speech-browser">
          <div class="comparison-screen local-screen">
            <strong class="workspace-brand"><img :src="naidanLogo" width="28" height="28" alt=""><span class="brand-copy"><span class="brand-name brand-wordmark">Naidan</span><span class="brand-subtitle"><AudioLinesIcon :size="13" aria-hidden="true" />{{ messages.audio_generation_ui }}</span></span></strong>
            <div class="local-workspace-left">
              <div class="audio-editor" data-testid="docs-local-speech-input">
                <small>{{ messages.audio_model_label }}</small><span class="select-field"><span class="model-id">{{ messages.qwen3_tts_model_id }}</span><ChevronDownIcon :size="13" aria-hidden="true" /></span>
                <small>{{ messages.text_to_speak_label }}</small><p class="spoken-text"><HomeTypingText :text="messages.speech_text" /></p>
                <div class="editor-footer"><span class="language-field"><small>{{ messages.audio_language_label }}</small><span>{{ messages.audio_language_choice }}<ChevronDownIcon :size="13" aria-hidden="true" /></span></span><span class="generate-action"><AudioLinesIcon :size="15" aria-hidden="true" />{{ messages.generate_audio }}</span></div>
              </div>
              <div class="model-region" data-testid="docs-local-speech-model"><span class="model-path" aria-hidden="true" /><div class="engine-core"><span class="model-copy"><strong>{{ messages.qwen3_tts_1_7b_base }}</strong><span class="received-text" aria-hidden="true">{{ messages.speech_text }}</span></span><span class="wav-slot" aria-hidden="true" /></div></div>
            </div>
            <div class="audio-result" data-testid="docs-local-speech-result"><small>{{ messages.generated_audio_ui }}</small><div class="result-stage"><div class="result-card" data-testid="docs-local-speech-wav"><div class="result-heading"><span class="wav-slot" aria-hidden="true" /><span class="result-meta"><strong class="model-id">{{ messages.qwen3_tts_model_id }}</strong><small>24,000 Hz</small></span></div><p>{{ messages.speech_text }}</p><div class="player"><span class="play"><PlayIcon :size="15" fill="currentColor" aria-hidden="true" /></span><span class="player-track" /><small>0:00 / 0:04</small></div><span class="save-action"><DownloadIcon :size="15" aria-hidden="true" />{{ messages.save_wav }}</span></div></div></div>
            <div class="travel-layer local-travel" aria-hidden="true"><span class="moving-text">{{ messages.speech_text }}</span><span class="wav-artifact forming-wav"><AudioLinesIcon :size="18" /><b>WAV</b><span class="waveform"><i v-for="bar in 7" :key="bar" /></span></span><span class="wav-artifact moving-wav"><AudioLinesIcon :size="18" /><b>WAV</b><span class="waveform"><i v-for="bar in 7" :key="bar" /></span></span><span class="wav-artifact result-wav"><AudioLinesIcon :size="18" /><b>WAV</b><span class="waveform"><i v-for="bar in 7" :key="bar" /></span></span></div>
          </div>
        </HomeBrowserFrame>
      </div>
      <footer class="generation-guide-footer"><slot name="guide" /></footer>
    </section>
    <section class="comparison-mode remote-mode" :aria-label="messages.server_speech_generation_case">
      <div class="remote-route">
        <div class="remote-overhead"><div class="remote-server" data-testid="docs-remote-speech-server"><CloudIcon :size="25" aria-hidden="true" /><span class="server-copy"><strong>{{ messages.server }}</strong><span class="received-text" aria-hidden="true">{{ messages.speech_text }}</span></span><span class="wav-slot" aria-hidden="true" /></div><div class="outside-route" aria-hidden="true"><span /><span /></div></div>
        <HomeBrowserFrame identity="generic" :tab-label="messages.ai_service" class="comparison-browser" data-testid="docs-remote-speech-browser">
          <div class="comparison-screen remote-screen">
            <div class="service-header"><CloudIcon :size="23" aria-hidden="true" /><strong>{{ messages.ai_service }}</strong></div>
            <div class="remote-conversation">
              <div class="text-entry" data-testid="docs-remote-speech-input"><div class="text-composer" aria-hidden="true"><p><HomeTypingText :text="messages.speech_text" /></p><span class="send-action"><ArrowUpIcon :size="15" /></span></div><div class="sent-text"><p>{{ messages.speech_text }}</p></div></div>
              <div class="reply-bubble" data-testid="docs-remote-speech-result"><small>{{ messages.generated_audio_ui }}</small><div class="result-stage"><div class="result-card" data-testid="docs-remote-speech-wav"><div class="result-heading"><span class="wav-slot" aria-hidden="true" /><span class="result-meta"><strong>WAV</strong><small>24,000 Hz</small></span></div><p>{{ messages.speech_text }}</p><div class="player"><span class="play"><PlayIcon :size="15" fill="currentColor" aria-hidden="true" /></span><span class="player-track" /><small>0:00 / 0:04</small></div><span class="save-action"><DownloadIcon :size="15" aria-hidden="true" />{{ messages.save_wav }}</span></div></div></div>
            </div>
          </div>
        </HomeBrowserFrame>
        <div class="travel-layer remote-travel" aria-hidden="true"><span class="moving-text">{{ messages.speech_text }}</span><span class="wav-artifact forming-wav"><AudioLinesIcon :size="18" /><b>WAV</b><span class="waveform"><i v-for="bar in 7" :key="bar" /></span></span><span class="wav-artifact moving-wav"><AudioLinesIcon :size="18" /><b>WAV</b><span class="waveform"><i v-for="bar in 7" :key="bar" /></span></span><span class="wav-artifact result-wav"><AudioLinesIcon :size="18" /><b>WAV</b><span class="waveform"><i v-for="bar in 7" :key="bar" /></span></span></div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.speech-comparison {
  display: grid;
  grid-template-columns: repeat(2,minmax(0,1fr));
  align-items: start;
  gap: 22px;
  min-width: 0;
}
.comparison-mode {
  justify-self: center;
  width: 100%;
  max-width: 560px;
  min-width: 0;
}
.remote-mode {
  opacity: .64;
}
.remote-mode :deep(.browser-tab),.remote-mode .reply-bubble small,.remote-mode .result-card p,.remote-mode .result-meta small,.remote-mode .player small {
  color: var(--text);
}
.local-route,.remote-route {
  position: relative;
  display: grid;
  grid-template-columns: minmax(0,1fr);
  grid-template-rows: 100px 440px;
  min-width: 0;
}
.comparison-browser {
  grid-column: 1;
  grid-row: 2;
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 440px;
}
.local-mode .comparison-browser {
  border-color: color-mix(in srgb,var(--blue) 30%,var(--line-strong));
}
.remote-mode .comparison-browser {
  border-color: var(--line);
  background: color-mix(in srgb,var(--surface-2) 94%,var(--surface));
  box-shadow: none;
}
.remote-overhead {
  grid-column: 1;
  grid-row: 1;
  display: grid;
  grid-template-rows: auto minmax(0,1fr);
  justify-items: center;
  min-width: 0;
}
.remote-server {
  z-index: 2;
  display: flex;
  align-items: center;
  gap: 8px;
  width: min(100%,300px);
  height: 82px;
  min-width: 0;
  padding: 9px 11px;
  border: 1px solid var(--line-strong);
  border-radius: 25px;
  background: var(--surface-2);
  color: var(--text);
  font-size: 11px;
  line-height: 1.35;
  overflow-wrap: anywhere;
}
.remote-server > svg {
  flex: none;
  color: var(--muted);
}
.server-copy {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  min-width: 0;
  flex: 1;
}
.server-copy strong {
  font-size: 13px;
}
.outside-route {
  z-index: 1;
  display: flex;
  justify-content: center;
  gap: 30px;
  align-self: stretch;
  min-height: 0;
}
.outside-route span {
  position: relative;
  display: block;
  width: 2px;
  height: 100%;
  background: var(--blue);
}
.outside-route span::after {
  content: "";
  position: absolute;
  bottom: 2px;
  left: -3px;
  width: 7px;
  height: 7px;
  border-right: 2px solid var(--blue);
  border-bottom: 2px solid var(--blue);
  transform: rotate(45deg);
}
.outside-route span:last-child::after {
  top: 2px;
  bottom: auto;
  transform: rotate(225deg);
}
.comparison-screen {
  position: relative;
  flex: 1;
  min-width: 0;
  min-height: 0;
  padding: 12px;
}
.local-screen {
  --source-x:25%;
  --text-y:calc(100% - 185px);
  --model-y:75%;
  --wav-origin-x:calc(50% - 53px);
  --wav-origin-y:calc(100% - 61px);
  --wav-target-x:calc(50% + 57px);
  --wav-target-y:87px;
  display: grid;
  grid-template-columns: repeat(2,minmax(0,1fr));
  grid-template-rows: auto minmax(0,1fr);
  column-gap: 10px;
  row-gap: 6px;
  background: linear-gradient(160deg,var(--surface-2),var(--surface));
}
.local-workspace-left {
  grid-column: 1;
  grid-row: 2;
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
  gap: 7px;
  min-width: 0;
  min-height: 0;
}
.remote-screen {
  display: flex;
  flex-direction: column;
  background: color-mix(in srgb,var(--surface-2) 94%,var(--surface));
}
.workspace-brand {
  grid-column: 1 / -1;
  grid-row: 1;
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 35px;
  padding-bottom: 6px;
  border-bottom: 1px solid var(--line-strong);
}
.workspace-brand > img {
  display: block;
  flex: none;
}
.brand-copy {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  white-space: nowrap;
}
.brand-name {
  font-size: 18px;
  line-height: 1;
}
.brand-subtitle {
  display: flex;
  align-items: center;
  gap: 4px;
  color: var(--muted);
  font-size: 12px;
  line-height: 1.2;
  font-weight: 750;
}
.brand-subtitle svg {
  flex: none;
  color: var(--blue);
}
.audio-editor,.audio-result,.reply-bubble {
  min-width: 0;
  padding: 9px;
  border: 1px solid var(--line-strong);
  border-radius: 11px;
  background: var(--surface);
  overflow-wrap: anywhere;
}
.audio-editor small,.audio-result small,.reply-bubble small,.language-field small {
  display: block;
  margin-bottom: 4px;
  color: var(--muted);
  font-size: 11px;
  line-height: 1.3;
  font-weight: 750;
}
.audio-editor > small:not(:first-child) {
  margin-top: 6px;
}
.audio-editor > small,.select-field,.spoken-text,.language-field {
  animation: audio-input-disabled 8s linear -3.5s infinite both;
}
.select-field,.spoken-text,.language-field > span {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 4px;
  min-width: 0;
  margin: 0;
  padding: 5px 7px;
  border: 1px solid var(--line-strong);
  border-radius: 7px;
  background: var(--surface-2);
  font-size: 12px;
  line-height: 1.35;
}
.model-id {
  min-width: 0;
  overflow-wrap: anywhere;
  font-size: 10px;
  line-height: 1.3;
  font-weight: 600;
}
.select-field svg,.language-field svg {
  flex: none;
  color: var(--muted);
}
.spoken-text {
  min-height: 48px;
  font-size: 13px;
  line-height: 1.45;
}
.editor-footer {
  display: flex;
  align-items: end;
  justify-content: space-between;
  gap: 6px;
  margin-top: 7px;
  min-width: 0;
}
.language-field {
  min-width: 0;
  flex: 1;
}
.language-field > span {
  min-height: 27px;
}
.generate-action {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  min-height: 27px;
  padding: 5px 6px;
  border-radius: 7px;
  background: #1d4ed8;
  color: #fff;
  font-size: 11px;
  line-height: 1.2;
  font-weight: 750;
  text-align: center;
  animation: generate-press 8s linear -3.5s infinite both;
}
.generate-action svg {
  flex: none;
}
.model-region {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: flex-end;
  min-width: 0;
  height: 65px;
  flex: none;
}
.model-path {
  position: relative;
  width: 2px;
  height: 10px;
  flex: none;
  background: var(--blue);
  opacity: 0;
  animation: model-input-path 8s linear -3.5s infinite both;
}
.model-path::after {
  content: "";
  position: absolute;
  bottom: 0;
  left: -3px;
  width: 7px;
  height: 7px;
  border-right: 2px solid var(--blue);
  border-bottom: 2px solid var(--blue);
  transform: rotate(45deg);
}
.engine-core {
  z-index: 1;
  display: flex;
  align-items: center;
  gap: 5px;
  width: calc(100% - 10px);
  height: 54px;
  min-width: 0;
  padding: 4px 6px;
  border: 1px solid color-mix(in srgb,var(--blue) 24%,var(--line-strong));
  border-radius: 9px;
  background: color-mix(in srgb,var(--blue) 7%,var(--surface-2));
  color: var(--text);
  font-size: 10px;
  line-height: 1.25;
}
.model-copy {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  overflow-wrap: anywhere;
}
.engine-core strong {
  font-size: 11px;
}
.received-text {
  display: block;
  color: var(--text);
  font-size: 11px;
  line-height: 1.25;
  font-weight: 600;
  overflow-wrap: anywhere;
  opacity: 0;
  animation: received-text 8s linear -3.5s infinite both;
}
.wav-slot,.wav-artifact {
  width: 72px;
  height: 44px;
  flex: none;
}
.wav-artifact {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 2px;
  padding: 4px;
  border: 1px solid var(--line-strong);
  border-radius: 7px;
  background: var(--surface);
  color: var(--text);
  font-size: 10px;
  line-height: 1;
  font-weight: 800;
}
.wav-artifact > svg {
  flex: none;
  color: var(--blue);
}
.wav-artifact .waveform {
  gap: 1px;
  width: 18px;
  height: 18px;
}
.wav-artifact .waveform i {
  width: 2px;
}
.forming-wav {
  opacity: 0;
  animation: forming-wav 8s linear -3.5s infinite both;
}
.waveform {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 2px;
  min-width: 0;
  height: 22px;
}
.waveform i {
  display: block;
  width: 3px;
  height: 8px;
  flex: none;
  border-radius: 3px;
  background: var(--blue);
}
.waveform i:nth-child(2),.waveform i:nth-child(6) {
  height: 14px;
}
.waveform i:nth-child(3),.waveform i:nth-child(5) {
  height: 19px;
}
.waveform i:nth-child(4) {
  height: 22px;
}
.audio-result {
  grid-column: 2;
  grid-row: 2;
  display: grid;
  grid-template-rows: auto minmax(0,1fr);
  min-height: 0;
}
.audio-result > small,.reply-bubble > small {
  line-height: 14px;
}
.result-stage {
  position: relative;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}
.result-card {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 7px;
  min-width: 0;
  padding: 6px;
  opacity: 0;
  animation: compare-audio-reveal 8s ease-in-out -3.5s infinite both;
}
.result-heading {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  min-width: 0;
}
.result-meta {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  font-size: 11px;
  line-height: 1.2;
  overflow-wrap: anywhere;
}
.result-meta small {
  margin: 0;
  font-size: 10px;
}
.result-card p {
  margin: 0;
  color: var(--muted);
  font-size: 12px;
  line-height: 1.3;
}
.player {
  display: flex;
  align-items: center;
  gap: 7px;
  width: 100%;
  min-width: 0;
  padding: 5px 6px;
  border: 1px solid var(--line-strong);
  border-radius: 7px;
  background: var(--surface-2);
}
.play {
  display: grid;
  place-items: center;
  width: 25px;
  height: 25px;
  flex: none;
  border-radius: 50%;
  color: var(--blue);
}
.player-track {
  display: block;
  height: 5px;
  flex: 1;
  min-width: 8px;
  border-radius: 99px;
  background: var(--line-strong);
}
.player small {
  flex: none;
  margin: 0;
  color: var(--muted);
  font-size: 10px;
  white-space: nowrap;
}
.save-action {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 5px 7px;
  border-radius: 6px;
  background: color-mix(in srgb,var(--blue) 13%,var(--surface));
  color: var(--text);
  font-size: 11px;
  font-weight: 750;
}
.service-header {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  min-height: 35px;
  margin-bottom: 7px;
  padding: 0 2px 6px;
  border-bottom: 1px solid var(--line-strong);
  color: var(--text);
}
.service-header svg {
  flex: none;
  color: var(--muted);
}
.service-header strong {
  font-size: 15px;
  line-height: 1.3;
  overflow-wrap: anywhere;
}
.remote-conversation {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  flex: 1;
}
.text-entry {
  align-self: flex-end;
  display: grid;
  grid-template-columns: minmax(0,1fr);
  width: min(84%,330px);
  min-width: 0;
}
.text-composer,.sent-text {
  grid-column: 1;
  grid-row: 1;
  min-width: 0;
  border: 1px solid var(--line-strong);
  background: var(--surface);
  color: var(--text);
  overflow-wrap: anywhere;
}
.text-composer {
  display: grid;
  grid-template-columns: minmax(0,1fr) 30px;
  align-items: center;
  gap: 6px;
  padding: 7px 8px;
  border-radius: 12px;
  animation: composer-presence 8s linear -3.5s infinite both;
}
.text-composer p,.sent-text p {
  margin: 0;
  font-size: 14px;
  line-height: 1.55;
}
.send-action {
  display: grid;
  place-items: center;
  width: 30px;
  height: 30px;
  flex: none;
  border-radius: 8px;
  background: var(--text);
  color: var(--surface);
  animation: send-press 8s linear -3.5s infinite both;
}
.sent-text {
  padding: 10px 12px;
  border-radius: 13px 13px 4px 13px;
  opacity: 0;
  animation: sent-text-presence 8s linear -3.5s infinite both;
}
.reply-bubble {
  align-self: center;
  display: grid;
  grid-template-rows: auto minmax(0,1fr);
  width: min(100%,300px);
  height: 220px;
  margin-top: auto;
}
.reply-bubble small {
  margin-bottom: 5px;
}
.travel-layer {
  min-width: 0;
  pointer-events: none;
}
.local-travel {
  position: absolute;
  z-index: 4;
  inset: 0;
}
.moving-text {
  position: absolute;
  left: 50%;
  max-width: min(72%,245px);
  padding: 6px 8px;
  border: 1px solid var(--line-strong);
  border-radius: 7px;
  background: var(--surface);
  color: var(--text);
  box-shadow: 0 3px 9px #00000020;
  font-size: 12px;
  line-height: 1.3;
  font-weight: 650;
  text-align: center;
  overflow-wrap: anywhere;
  opacity: 0;
  transform: translateX(-50%);
}
.travel-layer .wav-artifact {
  position: absolute;
  left: var(--wav-origin-x);
  top: var(--wav-origin-y);
  transform: translateX(-50%);
}
.travel-layer .result-wav {
  left: var(--wav-target-x);
  top: var(--wav-target-y);
  opacity: 0;
  animation: compare-audio-reveal 8s ease-in-out -3.5s infinite both;
}
.travel-layer .moving-wav {
  box-shadow: 0 3px 9px #00000020;
  opacity: 0;
}
.local-travel .moving-text {
  left: var(--source-x);
  animation: local-text-travel 8s ease-in-out -3.5s infinite both;
}
.local-travel .moving-wav {
  animation: local-wav-travel 8s ease-in-out -3.5s infinite both;
}
.remote-route {
  --remote-text-y:44%;
  --screen-padding:12px;
  --wav-origin-x:calc(50% + min(50%,150px) - 48px);
  --wav-origin-y:19px;
  --wav-target-x:calc(50% - min(calc(50% - 1px - var(--screen-padding)),150px) + 52px);
  --wav-target-y:calc(100% - var(--screen-padding) - 186px);
}
.remote-travel {
  position: relative;
  z-index: 3;
  grid-column: 1;
  grid-row: 1 / 3;
  align-self: stretch;
}
.remote-travel .moving-text {
  animation: remote-text-travel 8s ease-in-out -3.5s infinite both;
}
.remote-travel .moving-wav {
  animation: remote-wav-travel 8s ease-in-out -3.5s infinite both;
}
.remote-mode .outside-route span {
  background: var(--text);
}
.remote-mode .outside-route span::after {
  border-color: var(--text);
}
.remote-mode .wav-artifact > svg,.remote-mode .play {
  color: var(--text);
}
.remote-mode .waveform i {
  background: var(--text);
}
.remote-mode .save-action {
  border: 1px solid var(--line-strong);
  background: var(--surface-2);
}
@keyframes generate-press {
  0%,8.5%,100% {
    transform: none;
    filter: none;
    opacity: 1;
  }
  9% {
    transform: translateY(1px) scale(.96);
    filter: brightness(.8);
    opacity: 1;
  }
  10%,75% {
    transform: none;
    filter: none;
    opacity: .5;
  }
  76% {
    transform: none;
    filter: none;
    opacity: 1;
  }
}
@keyframes audio-input-disabled {
  0%,9.5%,100% {
    opacity: 1;
  }
  10%,75% {
    opacity: .6;
  }
  76% {
    opacity: 1;
  }
}
@keyframes send-press {
  0%,8.5%,10%,100% {
    transform: none;
    filter: none;
  }
  9% {
    transform: translateY(1px) scale(.9);
    filter: brightness(.8);
  }
}
@keyframes composer-presence {
  0%,9.5% {
    opacity: 1;
  }
  10%,100% {
    opacity: 0;
  }
}
@keyframes sent-text-presence {
  0%,9.5% {
    opacity: 0;
  }
  10%,92% {
    opacity: 1;
  }
  92.01%,100% {
    opacity: 0;
  }
}
@keyframes model-input-path {
  0%,10%,29%,100% {
    opacity: 0;
  }
  12%,24% {
    opacity: 1;
  }
}
@keyframes local-text-travel {
  0%,10% {
    top: var(--text-y);
    opacity: 0;
  }
  12% {
    top: var(--text-y);
    opacity: 1;
  }
  24% {
    top: var(--model-y);
    opacity: 1;
  }
  29%,100% {
    top: var(--model-y);
    opacity: 0;
  }
}
@keyframes local-wav-travel {
  0%,54% {
    top: var(--wav-origin-y);
    left: var(--wav-origin-x);
    opacity: 0;
  }
  58% {
    top: var(--wav-origin-y);
    left: var(--wav-origin-x);
    opacity: 1;
  }
  69% {
    top: var(--wav-target-y);
    left: var(--wav-target-x);
    opacity: 1;
  }
  74%,100% {
    top: var(--wav-target-y);
    left: var(--wav-target-x);
    opacity: 0;
  }
}
@keyframes remote-text-travel {
  0%,10% {
    top: var(--remote-text-y);
    opacity: 0;
  }
  12% {
    top: var(--remote-text-y);
    opacity: 1;
  }
  24% {
    top: 18px;
    opacity: 1;
  }
  29%,100% {
    top: 18px;
    opacity: 0;
  }
}
@keyframes remote-wav-travel {
  0%,54% {
    top: var(--wav-origin-y);
    left: var(--wav-origin-x);
    opacity: 0;
  }
  58% {
    top: var(--wav-origin-y);
    left: var(--wav-origin-x);
    opacity: 1;
  }
  69% {
    top: var(--wav-target-y);
    left: var(--wav-target-x);
    opacity: 1;
  }
  74%,100% {
    top: var(--wav-target-y);
    left: var(--wav-target-x);
    opacity: 0;
  }
}
@keyframes received-text {
  0%,24%,100% {
    opacity: 0;
  }
  29%,92% {
    opacity: 1;
  }
  92.01% {
    opacity: 0;
  }
}
@keyframes forming-wav {
  0%,32%,100% {
    opacity: 0;
  }
  38%,55% {
    opacity: 1;
  }
  58% {
    opacity: 0;
  }
}
@keyframes compare-audio-reveal {
  0%,69% {
    opacity: 0;
  }
  76%,92% {
    opacity: 1;
  }
  92.01%,100% {
    opacity: 0;
  }
}
html:has(#docs-pause-motion:checked) .speech-comparison .moving-text,
html:has(#docs-pause-motion:checked) .speech-comparison .moving-wav {
  animation: none!important;
  opacity: 0;
}
html:has(#docs-pause-motion:checked) .speech-comparison .received-text,
html:has(#docs-pause-motion:checked) .speech-comparison .result-card,
html:has(#docs-pause-motion:checked) .speech-comparison .result-wav,
html:has(#docs-pause-motion:checked) .speech-comparison .sent-text {
  animation: none!important;
  opacity: 1;
}
html:has(#docs-pause-motion:checked) .speech-comparison .forming-wav {
  animation: none!important;
  opacity: 0;
}
html:has(#docs-pause-motion:checked) .speech-comparison .model-path {
  animation: none!important;
  opacity: 0;
}
html:has(#docs-pause-motion:checked) .speech-comparison .text-composer {
  animation: none!important;
  opacity: 0;
}
html:has(#docs-pause-motion:checked) .speech-comparison .generate-action,
html:has(#docs-pause-motion:checked) .speech-comparison .send-action {
  animation: none!important;
  transform: none;
  filter: none;
  opacity: 1;
}
html:has(#docs-pause-motion:checked) .speech-comparison .audio-editor > small,
html:has(#docs-pause-motion:checked) .speech-comparison .select-field,
html:has(#docs-pause-motion:checked) .speech-comparison .spoken-text,
html:has(#docs-pause-motion:checked) .speech-comparison .language-field {
  animation: none!important;
  opacity: 1;
}
@media(max-width:1160px) {
  .speech-comparison {
    grid-template-columns: minmax(0,1fr);
    gap: 24px;
  }
}
@media(max-width:620px) {
  .local-route,.remote-route {
    grid-template-rows: 100px 584px;
  }
  .comparison-browser {
    height: 584px;
  }
  .comparison-screen {
    padding: 8px;
  }
  .local-screen {
    --source-x:50%;
    --text-y:27%;
    --model-y:51%;
    --wav-origin-x:calc(100% - 56px);
    --wav-origin-y:calc(100% - 243px);
    --wav-target-x:56px;
    --wav-target-y:calc(100% - 158px);
    grid-template-columns: minmax(0,1fr);
    grid-template-rows: 35px minmax(0,1fr) 65px 180px;
    gap: 6px;
  }
  .local-workspace-left {
    display: contents;
  }
  .audio-editor {
    grid-column: 1;
    grid-row: 2;
  }
  .model-region {
    grid-column: 1;
    grid-row: 3;
  }
  .audio-result {
    grid-column: 1;
    grid-row: 4;
    padding: 7px;
  }
  .audio-result .result-card {
    gap: 4px;
    padding: 4px;
  }
  .reply-bubble {
    height: 220px;
  }
  .remote-route {
    --remote-text-y:34%;
    --screen-padding:8px;
  }
  .moving-text {
    max-width: 75%;
    font-size: 11px;
  }
}
@media(prefers-reduced-motion:reduce) {
  .moving-text,.moving-wav {
    animation: none!important;
    opacity: 0;
  }
  .received-text,.result-card,.result-wav,.sent-text {
    animation: none!important;
    opacity: 1;
  }
  .forming-wav {
    animation: none!important;
    opacity: 0;
  }
  .model-path {
    animation: none!important;
    opacity: 0;
  }
  .text-composer {
    animation: none!important;
    opacity: 0;
  }
  .generate-action,.send-action {
    animation: none!important;
    transform: none;
    filter: none;
    opacity: 1;
  }
  .audio-editor > small,.select-field,.spoken-text,.language-field {
    animation: none!important;
    opacity: 1;
  }
}
</style>
