<script setup lang="ts">
import { computed } from 'vue';
import { ArrowUpIcon, BirdIcon, BotIcon, CloudIcon, SendIcon, UserIcon } from 'lucide-vue-next';
import naidanLogo from '../../assets/naidan.svg';
import HomeBrowserFrame from './HomeBrowserFrame.vue';
import HomeLocalGenerationBadge from './HomeLocalGenerationBadge.vue';
import HomeTypingText from './HomeTypingText.vue';

const props = defineProps<{ messages: typeof import('../../pages/index/messages/en').messages }>();
const answerGlyphs = computed(() => {
  const characters = [...props.messages.chat_answer_chunks().join('')];
  return characters.map((character, index) => ({ character, offset: `${(index * 2.8 / Math.max(characters.length - 1, 1)).toFixed(3)}s` }));
});

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <div class="chat-comparison" data-docs-animation="chat-route-comparison" data-testid="docs-chat-route-comparison">
    <section class="comparison-mode local-mode" :aria-label="messages.naidan_gguf_chat">
      <div class="local-route">
        <HomeLocalGenerationBadge :claim="messages.no_prompt_sent" />
        <HomeBrowserFrame identity="naidan" tab-label="Naidan" class="comparison-browser" data-testid="docs-local-chat-browser">
          <div class="chat-screen local-screen">
            <div class="screen-header"><img :src="naidanLogo" width="27" height="27" alt=""><strong class="brand-wordmark">Naidan</strong><span>{{ messages.new_chat }}</span><small>{{ messages.gguf_model }}</small></div>
            <div class="conversation">
              <div class="prompt-turn"><div class="prompt-bubble" data-testid="docs-local-chat-question"><small><UserIcon :size="15" aria-hidden="true" />{{ messages.you }}</small><p>{{ messages.chat_question }}</p></div></div>
              <div class="model-route" data-testid="docs-local-chat-model">
                <div class="model-node"><span class="model-entry-path" aria-hidden="true" /><span class="model-icon" aria-hidden="true"><BotIcon :size="20" /></span><span class="model-copy"><strong>{{ messages.gguf_model }}</strong><span class="received-prompt" aria-hidden="true">{{ messages.chat_question }}</span><span class="node-answer" aria-hidden="true"><template v-for="(glyph, index) in answerGlyphs" :key="index"><span class="generated-glyph" :style="{ '--glyph-offset': glyph.offset }">{{ glyph.character }}</span><span class="moving-answer" :style="{ '--glyph-offset': glyph.offset }">{{ glyph.character }}</span></template></span></span><span class="model-activity" aria-hidden="true"><i /><i /><i /></span></div>
              </div>
              <div class="reply-turn"><div class="reply-bubble" data-testid="docs-local-chat-reply"><small><BirdIcon :size="15" aria-hidden="true" />Naidan</small><p class="answer-text" data-testid="docs-local-chat-answer"><span v-for="(glyph, index) in answerGlyphs" :key="index" class="answer-glyph" :style="{ '--glyph-offset': glyph.offset }">{{ glyph.character }}</span></p></div></div>
            </div>
            <div class="chat-composer" aria-hidden="true"><span><HomeTypingText :text="messages.chat_question" /></span><span class="send-action"><SendIcon :size="16" /></span></div>
            <div class="travel-layer local-travel" aria-hidden="true"><span class="moving-prompt">{{ messages.chat_question }}</span></div>
          </div>
        </HomeBrowserFrame>
      </div>
      <footer class="generation-guide-footer"><slot name="guide" /></footer>
    </section>
    <section class="comparison-mode remote-mode" :aria-label="messages.server_gguf_chat_case">
      <div class="remote-route">
        <div class="remote-overhead">
          <div class="remote-server" data-testid="docs-remote-chat-server"><CloudIcon :size="27" aria-hidden="true" /><span class="server-copy"><strong>{{ messages.server }}</strong><span class="received-prompt" aria-hidden="true">{{ messages.chat_question }}</span><span class="server-answer" aria-hidden="true"><template v-for="(glyph, index) in answerGlyphs" :key="index"><span class="generated-glyph" :style="{ '--glyph-offset': glyph.offset }">{{ glyph.character }}</span><span class="moving-answer" :style="{ '--glyph-offset': glyph.offset }">{{ glyph.character }}</span></template></span></span><span class="server-activity" aria-hidden="true"><i /><i /><i /></span></div>
          <div class="outside-route" aria-hidden="true"><span /><span /></div>
        </div>
        <HomeBrowserFrame identity="generic" :tab-label="messages.ai_service" class="comparison-browser" data-testid="docs-remote-chat-browser">
          <div class="chat-screen remote-screen">
            <div class="screen-header"><CloudIcon :size="24" aria-hidden="true" /><strong>{{ messages.ai_service }}</strong><span>{{ messages.new_chat }}</span></div>
            <div class="conversation remote-conversation">
              <div class="prompt-turn"><div class="prompt-bubble" data-testid="docs-remote-chat-question"><small><UserIcon :size="15" aria-hidden="true" />{{ messages.you }}</small><p>{{ messages.chat_question }}</p></div></div>
              <div class="reply-turn"><div class="reply-bubble" data-testid="docs-remote-chat-reply"><small><BotIcon :size="15" aria-hidden="true" />{{ messages.server }}</small><p class="answer-text" data-testid="docs-remote-chat-answer"><span v-for="(glyph, index) in answerGlyphs" :key="index" class="answer-glyph" :style="{ '--glyph-offset': glyph.offset }">{{ glyph.character }}</span></p></div></div>
            </div>
            <div class="chat-composer" aria-hidden="true"><span><HomeTypingText :text="messages.chat_question" /></span><span class="send-action"><ArrowUpIcon :size="16" /></span></div>
          </div>
        </HomeBrowserFrame>
        <div class="travel-layer remote-travel" aria-hidden="true"><span class="moving-prompt">{{ messages.chat_question }}</span></div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.chat-comparison {
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
.remote-mode :deep(.browser-tab),.remote-mode .screen-header span,.remote-mode .prompt-bubble small,.remote-mode .reply-bubble small {
  color: var(--text);
}
.local-route,.remote-route {
  position: relative;
  display: grid;
  grid-template-columns: minmax(0,1fr);
  grid-template-rows: 100px 480px;
  min-width: 0;
}
.remote-route {
  container-type: inline-size;
}
.comparison-browser {
  grid-column: 1;
  grid-row: 2;
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 480px;
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
  z-index: 2;
  grid-column: 1;
  grid-row: 1;
  display: grid;
  grid-template-rows: 86px 14px;
  justify-items: center;
  min-width: 0;
}
.remote-server {
  display: flex;
  align-items: center;
  gap: 8px;
  width: min(100%,300px);
  height: 86px;
  min-width: 0;
  padding: 9px 11px;
  border: 1px solid var(--line-strong);
  border-radius: 25px;
  background: var(--surface-2);
  color: var(--muted);
  font-size: 11px;
  line-height: 1.35;
  overflow-wrap: anywhere;
}
.remote-server > svg {
  flex: none;
  color: var(--muted);
}
.server-copy {
  position: relative;
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
  height: 66px;
}
.server-copy strong {
  color: var(--text);
  font-size: 13px;
}
.remote-server .received-prompt,.server-answer {
  position: absolute;
  right: 0;
  left: 0;
  display: block;
  overflow: hidden;
}
.remote-server .received-prompt {
  top: 20px;
  max-height: 31px;
}
.server-answer {
  --answer-entry-x:28px;
  --answer-flight-x:calc(var(--answer-entry-x) - max(50px, calc(50cqw - 100px)));
  --answer-flight-y:381px;
  top: 51px;
  height: 15px;
  overflow: visible;
  color: var(--text);
  font-size: 10px;
  line-height: 1.2;
}
.outside-route {
  display: flex;
  justify-content: center;
  gap: 30px;
  align-self: stretch;
  width: 100%;
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
  left: -3px;
  width: 7px;
  height: 7px;
  border-right: 2px solid var(--blue);
  border-bottom: 2px solid var(--blue);
}
.outside-route span:first-child::after {
  top: 2px;
  transform: rotate(225deg);
}
.outside-route span:last-child::after {
  bottom: 2px;
  transform: rotate(45deg);
}
.chat-screen {
  position: relative;
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  padding: 13px;
  background: linear-gradient(160deg,var(--surface-2),var(--surface));
}
.remote-screen {
  background: color-mix(in srgb,var(--surface-2) 94%,var(--surface));
}
.screen-header {
  display: flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
  min-height: 39px;
  padding-bottom: 7px;
  border-bottom: 1px solid var(--line-strong);
  color: var(--text);
}
.screen-header > img {
  display: block;
  flex: none;
}
.screen-header > svg {
  flex: none;
  color: var(--muted);
}
.screen-header strong {
  flex: none;
  font-size: 17px;
  line-height: 1.2;
}
.screen-header span {
  min-width: 0;
  overflow: hidden;
  color: var(--muted);
  font-size: 12px;
  font-weight: 700;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.screen-header small {
  margin-left: auto;
  padding: 3px 6px;
  border: 1px solid var(--line-strong);
  border-radius: 6px;
  color: var(--muted);
  font-size: 10px;
  line-height: 1.2;
  white-space: nowrap;
}
.conversation {
  display: flex;
  flex: 1;
  flex-direction: column;
  justify-content: space-between;
  gap: 5px;
  min-width: 0;
  min-height: 0;
  padding: 10px 0;
}
.prompt-turn {
  display: flex;
  justify-content: flex-end;
  min-width: 0;
}
.reply-turn {
  display: flex;
  justify-content: flex-start;
  min-width: 0;
}
.prompt-bubble,.reply-bubble {
  min-width: 0;
  padding: 9px 11px;
  border: 1px solid var(--line-strong);
  border-radius: 13px;
  background: var(--surface);
  color: var(--text);
  overflow-wrap: anywhere;
}
.prompt-bubble {
  width: min(86%,305px);
  border-bottom-right-radius: 4px;
  animation: sent-prompt-presence 8s linear -3.5s infinite both;
}
.reply-bubble {
  width: min(94%,330px);
  min-height: 98px;
  border-bottom-left-radius: 4px;
  animation: reply-presence 8s linear -3.5s infinite both;
}
.prompt-bubble small,.reply-bubble small {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 4px;
  color: var(--muted);
  font-size: 11px;
  line-height: 1.25;
  font-weight: 750;
}
.prompt-bubble small svg,.reply-bubble small svg {
  flex: none;
  color: var(--blue);
}
.prompt-bubble p,.reply-bubble p {
  margin: 0;
  font-size: 13px;
  line-height: 1.5;
}
.model-route {
  position: relative;
  z-index: 2;
  display: flex;
  align-items: flex-end;
  justify-content: center;
  min-width: 0;
  min-height: 128px;
  container-type: inline-size;
}
.model-entry-path {
  position: absolute;
  bottom: 100%;
  left: 50%;
  width: 2px;
  height: 20px;
  background: var(--blue);
  opacity: 0;
  animation: prompt-path-presence 8s linear -3.5s infinite both;
}
.model-entry-path::after {
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
.model-node {
  position: relative;
  display: flex;
  align-items: center;
  gap: 8px;
  width: min(100%,320px);
  min-height: 104px;
  min-width: 0;
  padding: 8px;
  border: 1px solid color-mix(in srgb,var(--blue) 30%,var(--line-strong));
  border-radius: 11px;
  background: color-mix(in srgb,var(--blue) 8%,var(--surface-2));
  color: var(--text);
}
.model-icon {
  display: grid;
  place-items: center;
  width: 32px;
  height: 32px;
  flex: none;
  border: 1px solid color-mix(in srgb,var(--blue) 40%,var(--line));
  border-radius: 7px;
  color: var(--blue);
}
.model-copy {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
  overflow-wrap: anywhere;
}
.model-copy strong {
  font-size: 12px;
  line-height: 1.2;
}
.received-prompt {
  display: block;
  color: var(--text);
  font-size: 11px;
  line-height: 1.25;
  font-weight: 600;
  opacity: 0;
  animation: received-prompt 8s linear -3.5s infinite both;
}
.node-answer {
  --answer-entry-x:28px;
  --answer-flight-x:calc(var(--answer-entry-x) - 13px - max(0px, calc(50cqw - 160px)) - 52px);
  --answer-flight-y:80px;
  position: relative;
  display: block;
  height: 28px;
  overflow: visible;
  color: var(--text);
  font-size: 11px;
  line-height: 1.25;
}
.generated-glyph {
  position: absolute;
  top: 0;
  left: 0;
  display: block;
  font-weight: 700;
  white-space: pre;
  opacity: 0;
  animation: local-generated-glyph 8s linear calc(-3.5s + var(--glyph-offset)) infinite both;
}
.remote-mode .generated-glyph {
  animation-name: remote-generated-glyph;
}
.model-activity,.server-activity {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 2px;
  height: 24px;
  flex: none;
  opacity: 0;
  animation: compute-stage 8s linear -3.5s infinite both;
}
.model-activity {
  animation-name: local-compute-stage;
}
.model-activity i,.server-activity i {
  display: block;
  width: 3px;
  height: 10px;
  border-radius: 3px;
  background: var(--blue);
  animation: bar-pulse .75s ease-in-out infinite alternate;
}
.model-activity i:nth-child(2),.server-activity i:nth-child(2) {
  height: 19px;
  animation-delay: -.35s;
}
.model-activity i:nth-child(3),.server-activity i:nth-child(3) {
  height: 13px;
  animation-delay: -.17s;
}
.answer-text {
  min-height: 59px;
  overflow-wrap: anywhere;
  animation: answer-presence 8s linear -3.5s infinite both;
}
.answer-glyph {
  opacity: 0;
  white-space: pre-wrap;
  animation: answer-glyph 8s linear calc(-3.5s + var(--glyph-offset)) infinite both;
}
.chat-composer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-width: 0;
  min-height: 44px;
  padding: 6px 8px;
  border: 1px solid var(--line-strong);
  border-radius: 10px;
  background: var(--surface);
  color: var(--text);
  font-size: 12px;
  line-height: 1.4;
  animation: composer-presence 8s linear -3.5s infinite both;
}
.chat-composer > span:first-child {
  min-width: 0;
  overflow-wrap: anywhere;
}
.send-action {
  display: grid;
  place-items: center;
  width: 30px;
  height: 30px;
  flex: none;
  border-radius: 8px;
  background: #1d4ed8;
  color: #fff;
  animation: send-press 8s linear -3.5s infinite both;
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
.moving-prompt {
  position: absolute;
  left: 50%;
  display: block;
  max-width: min(72%,245px);
  padding: 6px 8px;
  border: 1px solid var(--line-strong);
  border-radius: 7px;
  background: var(--surface);
  color: var(--text);
  box-shadow: 0 3px 9px #00000020;
  font-size: 11px;
  line-height: 1.3;
  font-weight: 650;
  text-align: center;
  overflow-wrap: anywhere;
  opacity: 0;
  transform: translateX(-50%);
}
.moving-answer {
  position: absolute;
  top: 0;
  left: 0;
  z-index: 4;
  display: block;
  color: var(--blue);
  font: inherit;
  font-weight: 700;
  white-space: pre;
  opacity: 0;
}
.local-travel .moving-prompt {
  animation: local-prompt-travel 8s ease-in-out -3.5s infinite both;
}
.node-answer .moving-answer {
  animation: local-answer-travel 8s linear calc(-3.5s + var(--glyph-offset)) infinite both;
}
.remote-travel {
  position: relative;
  z-index: 3;
  grid-column: 1;
  grid-row: 1 / 3;
  align-self: stretch;
}
.remote-travel .moving-prompt {
  animation: remote-prompt-travel 8s ease-in-out -3.5s infinite both;
}
.server-answer .moving-answer {
  animation: remote-answer-travel 8s linear calc(-3.5s + var(--glyph-offset)) infinite both;
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
  10%,92% {
    opacity: 0;
  }
  92.01%,100% {
    opacity: 1;
  }
}
@keyframes sent-prompt-presence {
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
@keyframes reply-presence {
  0%,45% {
    opacity: 0;
  }
  46%,92% {
    opacity: 1;
  }
  92.01%,100% {
    opacity: 0;
  }
}
@keyframes answer-presence {
  0%,45% {
    opacity: 0;
  }
  46%,92% {
    opacity: 1;
  }
  92.01%,100% {
    opacity: 0;
  }
}
@keyframes local-prompt-travel {
  0%,10% {
    top: 22%;
    opacity: 0;
  }
  12% {
    top: 22%;
    opacity: 1;
  }
  24% {
    top: 39%;
    opacity: 1;
  }
  29%,100% {
    top: 39%;
    opacity: 0;
  }
}
@keyframes local-answer-travel {
  0%,43.49% {
    transform: none;
    opacity: 0;
  }
  43.5% {
    transform: none;
    opacity: 1;
  }
  47% {
    transform: translate(var(--answer-flight-x),var(--answer-flight-y));
    opacity: 1;
  }
  47.01%,100% {
    transform: translate(var(--answer-flight-x),var(--answer-flight-y));
    opacity: 0;
  }
}
@keyframes remote-prompt-travel {
  0%,10% {
    top: 39%;
    opacity: 0;
  }
  12% {
    top: 39%;
    opacity: 1;
  }
  24% {
    top: 28px;
    opacity: 1;
  }
  29%,100% {
    top: 28px;
    opacity: 0;
  }
}
@keyframes remote-answer-travel {
  0%,38.99% {
    transform: none;
    opacity: 0;
  }
  39% {
    transform: none;
    opacity: 1;
  }
  47% {
    transform: translate(var(--answer-flight-x),var(--answer-flight-y));
    opacity: 1;
  }
  47.01%,100% {
    transform: translate(var(--answer-flight-x),var(--answer-flight-y));
    opacity: 0;
  }
}
@keyframes received-prompt {
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
@keyframes prompt-path-presence {
  0%,10%,29%,100% {
    opacity: 0;
  }
  12%,24% {
    opacity: 1;
  }
}
@keyframes local-generated-glyph {
  0%,43.19%,43.5%,100% {
    opacity: 0;
  }
  43.2%,43.45% {
    opacity: 1;
  }
}
@keyframes remote-generated-glyph {
  0%,38.69%,39%,100% {
    opacity: 0;
  }
  38.7%,38.95% {
    opacity: 1;
  }
}
@keyframes compute-stage {
  0%,29%,76%,100% {
    opacity: 0;
  }
  33%,75% {
    opacity: 1;
  }
}
@keyframes local-compute-stage {
  0%,29%,80%,100% {
    opacity: 0;
  }
  33%,79% {
    opacity: 1;
  }
}
@keyframes bar-pulse {
  from {
    opacity: .4;
    transform: scaleY(.47);
  }
  to {
    opacity: 1;
    transform: scaleY(1);
  }
}
@keyframes answer-glyph {
  0%,46.99% {
    opacity: 0;
  }
  47%,92% {
    opacity: 1;
  }
  92.01%,100% {
    opacity: 0;
  }
}
html:has(#docs-pause-motion:checked) .chat-comparison .moving-prompt,
html:has(#docs-pause-motion:checked) .chat-comparison .moving-answer,
html:has(#docs-pause-motion:checked) .chat-comparison .model-activity,
html:has(#docs-pause-motion:checked) .chat-comparison .server-activity,
html:has(#docs-pause-motion:checked) .chat-comparison .model-entry-path,
html:has(#docs-pause-motion:checked) .chat-comparison .generated-glyph,
html:has(#docs-pause-motion:checked) .chat-comparison .chat-composer {
  animation: none!important;
  opacity: 0;
}
html:has(#docs-pause-motion:checked) .chat-comparison .received-prompt,
html:has(#docs-pause-motion:checked) .chat-comparison .prompt-bubble,
html:has(#docs-pause-motion:checked) .chat-comparison .reply-bubble,
html:has(#docs-pause-motion:checked) .chat-comparison .answer-text,
html:has(#docs-pause-motion:checked) .chat-comparison .answer-glyph {
  animation: none!important;
  opacity: 1;
}
html:has(#docs-pause-motion:checked) .chat-comparison .model-activity i,
html:has(#docs-pause-motion:checked) .chat-comparison .server-activity i,
html:has(#docs-pause-motion:checked) .chat-comparison .send-action {
  animation: none!important;
  transform: none;
}
@media(max-width:1160px) {
  .chat-comparison {
    grid-template-columns: minmax(0,1fr);
    gap: 24px;
  }
}
@media(max-width:620px) {
  .local-route,.remote-route {
    grid-template-rows: 100px 532px;
  }
  .comparison-browser {
    height: 532px;
  }
  .chat-screen {
    padding: 9px;
  }
  .screen-header small {
    display: none;
  }
  .prompt-bubble,.reply-bubble {
    padding: 8px;
  }
  .model-node {
    padding: 7px;
  }
  .reply-bubble {
    min-height: 128px;
  }
  .node-answer {
    --answer-entry-x:21px;
    --answer-flight-x:calc(var(--answer-entry-x) - 9px - max(0px, calc(50cqw - 160px)) - 52px);
  }
  .server-answer {
    --answer-entry-x:21px;
    --answer-flight-y:407px;
  }
}
@media(prefers-reduced-motion:reduce) {
  .moving-prompt,.moving-answer,.model-activity,.server-activity,.model-entry-path,.generated-glyph,.chat-composer {
    animation: none!important;
    opacity: 0;
  }
  .received-prompt,.prompt-bubble,.reply-bubble,.answer-text,.answer-glyph {
    animation: none!important;
    opacity: 1;
  }
  .model-activity i,.server-activity i,.send-action {
    animation: none!important;
    transform: none;
  }
}
</style>
