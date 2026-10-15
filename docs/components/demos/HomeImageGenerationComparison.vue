<script setup lang="ts">
import { ArrowUpIcon, BotIcon, CloudIcon, ImageIcon } from 'lucide-vue-next';
import catArtwork from '../../assets/flying-kitten.webp';
import naidanLogo from '../../assets/naidan.svg';
import HomeBrowserFrame from './HomeBrowserFrame.vue';
import HomeTypingText from './HomeTypingText.vue';

defineProps<{ messages: typeof import('../../pages/index/messages/en').messages }>();

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <div class="image-comparison" data-docs-animation="image-route-comparison" data-testid="docs-image-route-comparison">
    <section class="comparison-mode local-mode" :aria-label="messages.naidan_image_generation">
      <div class="local-route">
        <div class="local-overhead"><span>{{ messages.no_prompt_sent }}</span></div>
        <HomeBrowserFrame identity="naidan" tab-label="Naidan" class="comparison-browser" data-testid="docs-local-image-browser">
          <div class="comparison-screen local-screen">
            <strong class="workspace-brand"><img :src="naidanLogo" width="28" height="28" alt=""><span class="brand-copy"><span class="brand-name brand-wordmark">Naidan</span><span class="brand-subtitle">{{ messages.image_generation_ui }}</span></span></strong>
            <div class="local-workspace-left">
              <div class="image-editor" data-testid="docs-local-image-prompt">
                <small>{{ messages.image_prompt_label }}</small>
                <p><HomeTypingText :text="messages.cat_image_prompt" /></p>
                <span class="generate-action"><ImageIcon :size="15" aria-hidden="true" />{{ messages.generate_image }}</span>
              </div>
              <div class="model-region" data-testid="docs-local-image-model">
                <span class="model-path" aria-hidden="true" />
                <div class="engine-core"><span class="model-copy"><strong>{{ messages.image_model }}</strong><span class="received-prompt" aria-hidden="true">{{ messages.cat_image_prompt }}</span></span><span class="forming-image" aria-hidden="true"><img :src="catArtwork" alt=""></span></div>
              </div>
            </div>
            <div class="image-result" data-testid="docs-local-image-result">
              <small>{{ messages.image_result_panel }}</small>
              <div class="result-stage"><img :src="catArtwork" :alt="messages.cat_image_alt" data-testid="docs-local-image-result-art"></div>
            </div>
            <div class="travel-layer local-travel" aria-hidden="true"><span class="moving-prompt">{{ messages.cat_image_prompt }}</span><img class="moving-image" :src="catArtwork" alt=""></div>
          </div>
        </HomeBrowserFrame>
      </div>
      <footer class="generation-guide-footer"><slot name="guide" /></footer>
    </section>
    <section class="comparison-mode remote-mode" :aria-label="messages.server_image_generation_case">
      <div class="remote-route">
        <div class="remote-overhead">
          <div class="remote-server" data-testid="docs-remote-image-server"><CloudIcon :size="27" aria-hidden="true" /><span class="server-copy"><strong>{{ messages.server }}</strong><span class="received-prompt" aria-hidden="true">{{ messages.cat_image_prompt }}</span></span><span class="forming-image" aria-hidden="true"><img :src="catArtwork" alt=""></span></div>
          <div class="outside-route" aria-hidden="true"><span /><span /></div>
        </div>
        <HomeBrowserFrame identity="generic" :tab-label="messages.ai_service" class="comparison-browser" data-testid="docs-remote-image-browser">
          <div class="comparison-screen remote-screen">
            <div class="service-header"><CloudIcon :size="23" aria-hidden="true" /><strong>{{ messages.ai_service }}</strong></div>
            <div class="remote-conversation">
              <div class="prompt-entry" data-testid="docs-remote-image-prompt">
                <div class="prompt-composer" aria-hidden="true"><p><HomeTypingText :text="messages.cat_image_prompt" /></p><span class="send-action"><ArrowUpIcon :size="15" /></span></div>
                <div class="prompt-bubble"><p>{{ messages.cat_image_prompt }}</p></div>
              </div>
              <div class="reply-bubble" data-testid="docs-remote-image-result">
                <small><BotIcon :size="16" aria-hidden="true" />{{ messages.generated_image }}</small>
                <div class="result-stage"><img :src="catArtwork" :alt="messages.cat_image_alt" data-testid="docs-remote-image-result-art"></div>
              </div>
            </div>
          </div>
        </HomeBrowserFrame>
        <div class="travel-layer remote-travel" aria-hidden="true"><span class="moving-prompt">{{ messages.cat_image_prompt }}</span><img class="moving-image" :src="catArtwork" alt=""></div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.image-comparison { display:grid;grid-template-columns:repeat(2,minmax(0,1fr));align-items:start;gap:22px;min-width:0; }
.comparison-mode { justify-self:center;width:100%;max-width:560px;min-width:0; }
.remote-mode { opacity:.64; }
.remote-mode :deep(.browser-tab),.remote-mode .reply-bubble small { color:var(--text); }
.local-route,.remote-route { position:relative;display:grid;grid-template-columns:minmax(0,1fr);grid-template-rows:100px 440px;min-width:0; }
.comparison-browser { grid-column:1;grid-row:2;display:flex;flex-direction:column;width:100%;height:440px; }
.local-mode .comparison-browser { border-color:color-mix(in srgb,var(--blue) 30%,var(--line-strong)); }
.remote-mode .comparison-browser { border-color:var(--line);background:color-mix(in srgb,var(--surface-2) 94%,var(--surface));box-shadow:none; }
.local-overhead { grid-column:1;grid-row:1;display:flex;align-items:center;justify-content:center;min-width:0; }
.local-overhead span { display:inline-flex;align-items:center;gap:7px;max-width:100%;padding:7px 11px;border:1px solid color-mix(in srgb,var(--blue) 30%,var(--line-strong));border-radius:999px;background:color-mix(in srgb,var(--blue) 7%,var(--surface));color:var(--text);font-size:12px;line-height:1.35;font-weight:750;text-align:center;overflow-wrap:anywhere; }
.local-overhead span::before { content:"";display:block;width:7px;height:7px;flex:none;border-radius:50%;background:var(--blue); }
.remote-overhead { grid-column:1;grid-row:1;display:grid;grid-template-rows:auto minmax(0,1fr);justify-items:center;min-width:0; }
.remote-server { z-index:2;display:flex;align-items:center;gap:8px;width:min(100%,300px);height:82px;min-width:0;padding:9px 11px;border:1px solid var(--line-strong);border-radius:25px;background:var(--surface-2);color:var(--muted);font-size:11px;line-height:1.35;overflow-wrap:anywhere; }
.remote-server > svg { flex:none;color:var(--muted); }
.server-copy { display:flex;flex-direction:column;align-items:flex-start;gap:2px;min-width:0;flex:1; }
.server-copy strong { color:var(--text);font-size:13px; }
.outside-route { z-index:1;display:flex;justify-content:center;gap:30px;align-self:stretch;min-height:0; }
.outside-route span { position:relative;display:block;width:2px;height:100%;background:var(--blue); }
.outside-route span::after { content:"";position:absolute;bottom:2px;left:-3px;width:7px;height:7px;border-right:2px solid var(--blue);border-bottom:2px solid var(--blue);transform:rotate(45deg); }
.outside-route span:last-child::after { top:2px;bottom:auto;transform:rotate(225deg); }
.comparison-screen { position:relative;flex:1;min-width:0;min-height:0;padding:16px; }
.local-screen { --source-x:25%;--grid-x:calc(50% - 44px);--result-x:75%;--prompt-y:35%;--model-y:71%;--image-y:61%;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));grid-template-rows:auto minmax(0,1fr);column-gap:12px;row-gap:8px;background:linear-gradient(160deg,var(--surface-2),var(--surface)); }
.local-workspace-left { grid-column:1;grid-row:2;display:flex;flex-direction:column;justify-content:center;gap:16px;min-width:0;min-height:0; }
.remote-screen { display:flex;flex-direction:column;background:color-mix(in srgb,var(--surface-2) 94%,var(--surface)); }
.image-editor,.image-result { min-width:0;padding:12px;border:1px solid var(--line-strong);border-radius:11px;background:var(--surface);overflow-wrap:anywhere; }
.workspace-brand { grid-column:1 / -1;grid-row:1;display:flex;align-items:center;gap:8px;min-height:39px;padding-bottom:7px;border-bottom:1px solid var(--line-strong); }
.workspace-brand > img { display:block;flex:none; }
.brand-copy { display:flex;align-items:center;gap:8px;min-width:0;white-space:nowrap; }
.brand-name { font-size:19px;line-height:1; }
.brand-subtitle { color:var(--muted);font-size:12px;line-height:1.2;font-weight:750; }
.image-editor small,.image-result small,.reply-bubble small { display:block;margin-bottom:6px;color:var(--muted);font-size:12px;line-height:1.45;font-weight:750; }
.image-editor p { min-height:54px;margin:0;padding:8px 10px;border:1px solid var(--line-strong);border-radius:8px;background:var(--surface-2);font-size:14px;line-height:1.55; }
.generate-action { display:inline-flex;align-items:center;gap:6px;margin-top:9px;padding:7px 10px;border-radius:8px;background:#1d4ed8;color:#fff;font-size:13px;line-height:1.35;font-weight:750;animation:generate-press 8s linear -3.5s infinite both; }
.model-region { position:relative;display:flex;align-items:center;justify-content:center;min-width:0;height:68px;flex:none; }
.model-path { position:absolute;top:-16px;left:50%;width:2px;height:21px;background:var(--blue);opacity:0;animation:model-path-presence 8s linear -3.5s infinite both; }
.model-path::after { content:"";position:absolute;bottom:0;left:-3px;width:7px;height:7px;border-right:2px solid var(--blue);border-bottom:2px solid var(--blue);transform:rotate(45deg); }
.engine-core { z-index:1;display:flex;align-items:center;justify-content:center;gap:7px;width:calc(100% - 12px);min-width:0;padding:4px 7px;border:1px solid color-mix(in srgb,var(--blue) 24%,var(--line-strong));border-radius:9px;background:color-mix(in srgb,var(--blue) 7%,var(--surface-2));color:var(--text);font-size:11px;line-height:1.3; }
.model-copy { display:flex;flex:1;flex-direction:column;gap:2px;min-width:0;overflow-wrap:anywhere; }
.engine-core strong { font-size:12px; }
.received-prompt { display:block;color:var(--text);font-size:11px;line-height:1.25;font-weight:600;overflow-wrap:anywhere;animation:received-prompt 8s linear -3.5s infinite both; }
.forming-image { position:relative;display:block;width:48px;height:48px;flex:none;overflow:hidden;border:1px solid var(--line-strong);border-radius:5px;background:var(--surface); }
.forming-image img { display:block;width:100%;height:100%;object-fit:contain;animation:forming-cat 8s linear -3.5s infinite both; }
.forming-image::after { content:"";position:absolute;inset:0;background-image:linear-gradient(90deg,transparent 78%,var(--surface-2) 78%),linear-gradient(0deg,transparent 78%,var(--surface-2) 78%);background-size:10px 10px;animation:forming-grid 8s linear -3.5s infinite both; }
.image-result,.reply-bubble { display:grid;grid-template-rows:auto minmax(0,1fr);min-height:0; }
.image-result { grid-column:2;grid-row:2; }
.result-stage { position:relative;min-width:0;min-height:0;overflow:hidden;background:var(--surface); }
.result-stage > img { position:absolute;top:50%;left:50%;display:block;width:160px;max-width:100%;height:auto;aspect-ratio:1;object-fit:contain;border-radius:8px;opacity:0;transform:translate(-50%,-50%);animation:compare-image-reveal 8s ease-in-out -3.5s infinite both; }
.local-screen .result-stage > img { top:64%; }
.service-header { display:flex;align-items:center;gap:8px;min-width:0;min-height:39px;margin-bottom:8px;padding:0 2px 7px;border-bottom:1px solid var(--line-strong);color:var(--text); }
.service-header svg { flex:none;color:var(--muted); }
.service-header strong { font-size:15px;line-height:1.3;overflow-wrap:anywhere; }
.remote-conversation { display:flex;flex-direction:column;min-width:0;min-height:0;flex:1; }
.prompt-entry { align-self:flex-end;display:grid;grid-template-columns:minmax(0,1fr);width:min(84%,330px);min-width:0; }
.prompt-composer,.prompt-bubble { grid-column:1;grid-row:1;min-width:0;border:1px solid var(--line-strong);background:var(--surface);color:var(--text);overflow-wrap:anywhere; }
.prompt-composer { display:grid;grid-template-columns:minmax(0,1fr) 30px;align-items:center;gap:6px;padding:7px 8px;border-radius:12px;animation:composer-presence 8s linear -3.5s infinite both; }
.prompt-composer p,.prompt-bubble p { margin:0;font-size:14px;line-height:1.55; }
.send-action { display:grid;place-items:center;width:30px;height:30px;flex:none;border-radius:8px;background:#1d4ed8;color:#fff;animation:send-press 8s linear -3.5s infinite both; }
.prompt-bubble { padding:11px 13px;border-radius:13px 13px 4px 13px;animation:sent-prompt-presence 8s linear -3.5s infinite both; }
.reply-bubble { align-self:center;width:min(100%,300px);height:230px;margin-top:auto;padding:12px;border:1px solid var(--line-strong);border-radius:13px 13px 13px 4px;background:var(--surface); }
.reply-bubble small { display:flex;align-items:center;gap:6px; }
.reply-bubble small svg { flex:none;color:var(--muted); }
.travel-layer { min-width:0;pointer-events:none; }
.local-travel { position:absolute;z-index:4;inset:0; }
.moving-prompt { position:absolute;left:50%;display:block;max-width:min(72%,245px);padding:6px 8px;border:1px solid var(--line-strong);border-radius:7px;background:var(--surface);color:var(--text);box-shadow:0 3px 9px #00000020;font-size:12px;line-height:1.3;font-weight:650;text-align:center;overflow-wrap:anywhere;opacity:0;transform:translateX(-50%); }
.moving-image { position:absolute;left:50%;display:block;width:54px;height:54px;object-fit:contain;border:1px solid var(--line-strong);border-radius:7px;background:var(--surface);box-shadow:0 3px 9px #00000020;opacity:0;transform:translateX(-50%); }
.local-travel .moving-prompt { left:var(--source-x);animation:local-prompt-travel 8s ease-in-out -3.5s infinite both; }
.local-travel .moving-image { left:var(--grid-x);animation:local-image-travel 8s ease-in-out -3.5s infinite both; }
.remote-route { --server-grid-x:calc(50% + min(50%, 150px) - 36px);--remote-prompt-y:44%;--remote-image-y:73%; }
.remote-travel { position:relative;z-index:3;grid-column:1;grid-row:1 / 3;align-self:stretch; }
.remote-travel .moving-prompt { animation:remote-prompt-travel 8s ease-in-out -3.5s infinite both; }
.remote-travel .moving-image { animation:remote-image-travel 8s ease-in-out -3.5s infinite both; }
@keyframes generate-press { 0%,8.5%,10%,100% { transform:none;filter:none; } 9% { transform:translateY(1px) scale(.96);filter:brightness(.8); } }
@keyframes send-press { 0%,8.5%,10%,100% { transform:none;filter:none; } 9% { transform:translateY(1px) scale(.9);filter:brightness(.8); } }
@keyframes composer-presence { 0%,9.5% { opacity:1; } 10%,100% { opacity:0; } }
@keyframes sent-prompt-presence { 0%,9.5% { opacity:0; } 10%,92% { opacity:1; } 92.01%,100% { opacity:0; } }
@keyframes model-path-presence { 0%,10%,29%,100% { opacity:0; } 12%,24% { opacity:1; } }
@keyframes local-prompt-travel { 0%,10% { top:var(--prompt-y);opacity:0; } 12% { top:var(--prompt-y);opacity:1; } 24% { top:var(--model-y);opacity:1; } 29%,100% { top:var(--model-y);opacity:0; } }
@keyframes local-image-travel { 0%,54% { top:var(--model-y);left:var(--grid-x);opacity:0; } 58% { top:var(--model-y);left:var(--grid-x);opacity:1; } 69% { top:var(--image-y);left:var(--result-x);opacity:1; } 74%,100% { top:var(--image-y);left:var(--result-x);opacity:0; } }
@keyframes remote-prompt-travel { 0%,10% { top:var(--remote-prompt-y);opacity:0; } 12% { top:var(--remote-prompt-y);opacity:1; } 24% { top:18px;opacity:1; } 29%,100% { top:18px;opacity:0; } }
@keyframes remote-image-travel { 0%,54% { top:14px;left:var(--server-grid-x);opacity:0; } 58% { top:14px;left:var(--server-grid-x);opacity:1; } 69% { top:var(--remote-image-y);left:50%;opacity:1; } 74%,100% { top:var(--remote-image-y);left:50%;opacity:0; } }
@keyframes received-prompt { 0%,24%,100% { opacity:0; } 29%,92% { opacity:1; } 92.01% { opacity:0; } }
@keyframes forming-cat { 0%,28%,100% { opacity:0;filter:blur(8px); } 32% { opacity:.72;filter:blur(8px); } 44% { opacity:1;filter:blur(3px); } 55% { opacity:1;filter:blur(0); } 58%,92% { opacity:.14;filter:blur(0); } 92.01% { opacity:0; } }
@keyframes forming-grid { 0%,28%,100% { opacity:0; } 32% { opacity:.9; } 50% { opacity:.48; } 58%,92% { opacity:.1; } 92.01% { opacity:0; } }
@keyframes compare-image-reveal { 0%,69% { opacity:0; } 76%,92% { opacity:1; } 92.01%,100% { opacity:0; } }
html:has(#docs-pause-motion:checked) .image-comparison .moving-prompt,
html:has(#docs-pause-motion:checked) .image-comparison .moving-image { animation:none!important;opacity:0; }
html:has(#docs-pause-motion:checked) .image-comparison .forming-image img { animation:none!important;opacity:.14;filter:none; }
html:has(#docs-pause-motion:checked) .image-comparison .forming-image::after { animation:none!important;opacity:.1; }
html:has(#docs-pause-motion:checked) .image-comparison .received-prompt { animation:none!important;opacity:1; }
html:has(#docs-pause-motion:checked) .image-comparison .result-stage > img { animation:none!important;opacity:1; }
html:has(#docs-pause-motion:checked) .image-comparison .prompt-bubble { animation:none!important;opacity:1; }
html:has(#docs-pause-motion:checked) .image-comparison .prompt-composer { animation:none!important;opacity:0; }
html:has(#docs-pause-motion:checked) .image-comparison .generate-action { animation:none!important;transform:none;filter:none; }
html:has(#docs-pause-motion:checked) .image-comparison .model-path { animation:none!important;opacity:0; }
@media(max-width:1160px) { .image-comparison { grid-template-columns:minmax(0,1fr);gap:24px; } }
@media(max-width:620px) {
  .local-route,.remote-route { grid-template-rows:100px 584px; }
  .comparison-browser { height:584px; }
  .comparison-screen { padding:8px; }
  .image-editor,.image-result,.reply-bubble { padding:8px; }
  .image-result { padding-block:6px; }
  .image-editor p { min-height:84px; }
  .local-screen { --source-x:50%;--grid-x:calc(100% - 46px);--result-x:50%;--prompt-y:16%;--model-y:44%;--image-y:75%;grid-template-columns:minmax(0,1fr);grid-template-rows:auto auto 68px minmax(0,1fr);gap:6px; }
  .local-workspace-left { display:contents; }
  .image-editor { grid-column:1;grid-row:2; }
  .model-region { grid-column:1;grid-row:3; }
  .model-path { top:-6px;height:11px; }
  .image-result { grid-column:1;grid-row:4; }
  .local-screen .result-stage > img { top:50%; }
  .remote-route { --remote-prompt-y:34%;--remote-image-y:80%; }
  .moving-prompt { max-width:75%;font-size:11px; }
}
@media(prefers-reduced-motion:reduce) {
  .moving-prompt,.moving-image { animation:none!important;opacity:0; }
  .forming-image img { animation:none!important;opacity:.14;filter:none; }
  .forming-image::after { animation:none!important;opacity:.1; }
  .received-prompt { animation:none!important;opacity:1; }
  .result-stage > img { animation:none!important;opacity:1; }
  .prompt-bubble { animation:none!important;opacity:1; }
  .prompt-composer { animation:none!important;opacity:0; }
  .generate-action { animation:none!important;transform:none;filter:none; }
  .model-path { animation:none!important;opacity:0; }
}
</style>
