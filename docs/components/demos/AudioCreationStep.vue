<script setup lang="ts">
import { AudioLinesIcon, CheckIcon, ChevronDownIcon, DownloadIcon, FolderOpenIcon, LibraryBigIcon, Loader2Icon, MicIcon, MoreVerticalIcon, MousePointer2Icon, PlayIcon, RefreshCwIcon, SearchIcon, SettingsIcon, Trash2Icon } from 'lucide-vue-next';
import type { AudioSpeechMessages } from '../../messages/types';

defineProps<{ stage: 'open' | 'text' | 'generate' | 'save'; messages: AudioSpeechMessages }>();
defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <div class="camera" :class="`stage-${stage}`" :data-docs-animation="`audio-${stage}`" :data-testid="`audio-step-${stage}`" aria-hidden="true">
    <div class="canvas">
      <aside class="sidebar"><strong>{{ messages.naidan }}</strong><div class="sidebar-spacer" /><div class="sidebar-actions"><SettingsIcon :size="17" /><span class="more"><MoreVerticalIcon :size="18" /><MousePointer2Icon v-if="stage === 'open'" class="pointer" :size="20" /></span></div><div v-if="stage === 'open'" class="menu"><small>{{ messages.more_actions }}</small><div><AudioLinesIcon :size="16" />{{ messages.audio_generation }}</div></div></aside>
      <main class="audio-app" data-testid="audio-workspace-canvas">
        <header class="page-head"><h3><AudioLinesIcon :size="24" />{{ messages.audio_generation }}</h3><p>{{ messages.independent_speech_workspace }}</p></header>
        <div class="catalog"><div class="catalog-head"><LibraryBigIcon :size="16" /><strong>{{ messages.model_catalog }}</strong><ChevronDownIcon :size="15" /></div><div class="suggestion"><div class="suggestion-details"><strong>{{ messages.qwen3_tts_base }}</strong><small>{{ messages.required_audio_companion_included }}</small></div><span class="suggestion-action"><span class="suggestion-download"><DownloadIcon :size="14" />{{ messages.download }}</span><span class="suggestion-use">{{ messages.use_this_model }}</span></span></div></div>
        <div class="manager"><FolderOpenIcon :size="16" /><strong>{{ messages.models_and_runtime }}</strong><ChevronDownIcon :size="16" /></div>
        <div class="form-field model-field"><div class="label">{{ messages.audio_model }}</div><div class="select-field"><span class="model-choice"><span class="model-before">{{ messages.choose_an_imported_model }}</span><span class="model-after">{{ messages.qwen3_tts_base }}</span></span><ChevronDownIcon :size="16" /></div><div v-if="stage === 'text'" class="model-popup" data-testid="audio-model-options"><div class="popup-search"><SearchIcon :size="14" /><span>{{ messages.filter_models }}</span><RefreshCwIcon :size="14" /></div><div class="popup-model"><span>{{ messages.qwen3_tts_base }}</span><CheckIcon :size="15" /></div></div></div>
        <div class="form-field"><div class="label">{{ messages.text_to_speak }}</div><div class="textarea"><span class="text-before">{{ messages.enter_text_to_speak }}</span><span class="text-after">{{ messages.morning_light_sample }}</span></div></div>
        <div class="form-field language-field"><div class="label">{{ messages.language }}</div><div class="select-field"><span>{{ messages.language_option }}</span><ChevronDownIcon :size="16" /></div><div v-if="stage === 'text'" class="language-popup" data-testid="audio-language-options"><span>{{ messages.model_default }}</span><strong>{{ messages.language_option }}<CheckIcon :size="14" /></strong><span>{{ messages.other_language_option }}</span></div></div>
        <div class="reference"><div><MicIcon :size="16" /><strong>{{ messages.reference_voice }}</strong></div><span>{{ messages.add_audio_files }}</span></div>
        <div class="manager settings"><strong>{{ messages.generation_settings }}</strong><ChevronDownIcon :size="16" /></div>
        <div class="generation-controls"><span class="primary generate"><AudioLinesIcon :size="17" />{{ messages.generate_audio }}</span><div class="busy-actions"><span>{{ messages.get_audio_so_far }}</span><span>{{ messages.finish_generation_and_keep_audio }}</span><span>{{ messages.cancel_and_discard }}</span></div></div>
        <div class="progress"><Loader2Icon :size="16" /><strong>{{ messages.generating_audio }}</strong><div class="progress-track"><span /></div></div>
        <section class="history" data-testid="audio-result-card"><div class="history-head"><h4>{{ messages.generated_audio }}</h4><span>{{ messages.delete_all_audio }}</span></div><div class="result-card"><div class="result-heading"><div><strong>{{ messages.qwen3_tts_base }}</strong><small>WAV · 24,000 Hz</small></div><span><Trash2Icon :size="14" />{{ messages.delete_audio }}</span></div><p>{{ messages.morning_light_sample }}</p><div class="player"><span class="play"><PlayIcon :size="16" fill="currentColor" /></span><div class="track"><span /></div><small>0:00 / 0:04</small><span class="download"><DownloadIcon :size="16" />{{ messages.save_wav }}</span></div><div class="settings-summary">{{ messages.settings_used_for_generation }}<ChevronDownIcon :size="14" /></div></div></section>
      </main>
    </div>
  </div>
</template>

<style scoped>
.camera { --p:var(--surface);--f:var(--surface-2);--l:var(--line-strong);--t:var(--text);--m:var(--muted);--a:#9554c2;position:relative;height:344px;max-width:720px;margin-inline:auto;overflow:hidden;border:1px solid var(--l);border-radius:15px;background:var(--bg);box-shadow:var(--panel-shadow);color:var(--t);font:12px/1.5 ui-sans-serif,system-ui,sans-serif; }
.camera * { box-sizing:border-box; }.canvas { position:absolute;left:0;top:0;display:grid;grid-template-columns:145px 850px;width:995px;min-height:1040px;transform-origin:0 0;animation:camera-pan 10s ease-in-out infinite; }.sidebar { position:relative;display:flex;flex-direction:column;padding:15px 11px;border-right:1px solid var(--l);background:var(--p); }.sidebar > strong { font-size:18px;letter-spacing:-.04em; }.sidebar-spacer { flex:1;min-height:270px; }.sidebar-actions { display:flex;align-items:center;gap:8px;color:var(--m); }.sidebar-actions > svg,.more { display:grid;place-items:center;width:33px;height:33px;border:1px solid var(--l);border-radius:10px;background:var(--f); }.more { position:relative; }.pointer { position:absolute;right:-7px;bottom:-8px;fill:var(--p);filter:drop-shadow(0 1px 2px #0008);animation:pointer-tap 10s linear infinite; }.menu { position:absolute;z-index:4;bottom:53px;left:36px;width:210px;padding:6px;border:1px solid var(--l);border-radius:11px;background:var(--p);box-shadow:0 12px 30px #0004;animation:menu-leave 10s linear infinite; }.menu small { display:block;padding:5px 8px;color:var(--m);font-weight:800; }.menu div { display:flex;align-items:center;gap:9px;padding:9px 8px;border-radius:7px;color:var(--a);background:color-mix(in srgb,var(--a) 12%,var(--p));font-weight:700; }
.audio-app { padding:22px 26px;width:850px;background:var(--bg); }.page-head h3 { display:flex;align-items:center;gap:11px;margin:0;color:var(--t);font-size:22px; }.page-head svg { color:var(--a); }.page-head p { margin:7px 0 18px;color:var(--m);font-size:12px; }.catalog { max-width:610px;margin-bottom:15px;border:1px solid var(--l);border-radius:14px;background:var(--p); }.catalog-head { display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid var(--l); }.catalog-head svg:first-child { color:var(--a); }.catalog-head svg:last-child { margin-left:auto; }.suggestion { display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 12px; }.suggestion-details { display:flex;flex-direction:column;min-width:0; }.suggestion-details small { color:var(--m); }.suggestion-action { display:grid;flex:none;padding:7px 12px;border:1px solid var(--l);border-radius:8px;color:var(--a);font-weight:700; }.suggestion-action > span { grid-area:1/1;display:flex;align-items:center;gap:5px; }.suggestion-download { opacity:0; }.manager { display:flex;align-items:center;gap:9px;margin-bottom:19px;padding:13px 15px;border:1px solid var(--l);border-radius:13px;background:var(--p); }.manager svg:last-child { margin-left:auto; }.form-field { margin:0 0 18px; }.label { margin-bottom:7px;font-weight:700; }.select-field,.textarea { display:flex;align-items:center;justify-content:space-between;gap:8px;padding:11px 13px;border:1px solid var(--l);border-radius:11px;background:var(--f);font-size:13px; }.select-field svg { color:var(--m); }.model-choice { display:grid; }.model-choice span { grid-area:1/1; }.model-before { color:var(--m);animation:model-before 10s linear infinite; }.model-after { opacity:0;animation:model-after 10s linear infinite; }.textarea { display:grid;align-items:start;min-height:93px; }.textarea span { grid-area:1/1; }.text-before { color:var(--m);animation:text-before 10s linear infinite; }.text-after { opacity:0;animation:text-after 10s linear infinite; }.language-field .select-field { max-width:280px; }.reference { display:flex;align-items:center;justify-content:space-between;gap:12px;margin:0 0 17px;padding:12px 15px;border:1px dashed var(--l);border-radius:11px;background:var(--p); }.reference div { display:flex;align-items:center;gap:8px; }.reference svg { color:var(--a); }.reference span { color:var(--m); }.settings { margin-bottom:17px; }.generation-controls { display:flex;align-items:center;gap:12px; }.primary { display:inline-flex;align-items:center;justify-content:center;gap:8px;padding:10px 17px;border-radius:10px;background:var(--a);color:white;font-weight:800; }.generate { animation:generate-tap 10s linear infinite; }.busy-actions { display:flex;gap:6px;opacity:0;animation:busy-actions 10s linear infinite; }.busy-actions span { padding:8px;border:1px solid var(--l);border-radius:8px;color:var(--a);font-size:10px;white-space:nowrap; }.progress { display:flex;align-items:center;gap:10px;margin:13px 0 18px;color:var(--a);opacity:0;animation:progress-show 10s linear infinite; }.progress-track { width:120px;height:7px;border-radius:99px;background:var(--l);overflow:hidden; }.progress-track span { display:block;width:100%;height:100%;background:var(--a);transform-origin:left;animation:progress-fill 10s linear infinite; }
.history { opacity:0;animation:history-show 10s linear infinite; }.history-head { display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:11px; }.history-head h4 { margin:0;font-size:17px; }.history-head > span,.result-heading > span { display:flex;align-items:center;gap:6px;padding:7px 9px;border:1px solid var(--l);border-radius:8px;color:var(--m);font-size:10px; }.result-card { padding:16px;border:1px solid var(--l);border-radius:15px;background:var(--p); }.result-heading { display:flex;align-items:start;justify-content:space-between;gap:10px; }.result-heading > div { display:flex;flex-direction:column;gap:3px; }.result-heading small { color:var(--m); }.result-card p { margin:14px 0;color:var(--m); }.player { display:flex;align-items:center;gap:11px;padding:9px 10px;border:1px solid var(--l);border-radius:10px;background:var(--f); }.play { display:grid;place-items:center;width:27px;height:27px;flex:none;border-radius:50%;color:var(--a); }.track { flex:1;min-width:35px;height:6px;border-radius:99px;background:var(--l);overflow:hidden; }.track span { display:block;width:60%;height:100%;background:var(--a);transform:scaleX(0);transform-origin:left; }.player small { color:var(--m);white-space:nowrap; }.download { display:flex;align-items:center;gap:7px;padding:8px 10px;border-radius:8px;background:color-mix(in srgb,var(--a) 12%,var(--f));color:var(--a);font-weight:700;white-space:nowrap;animation:save-tap 10s linear infinite; }.settings-summary { display:flex;align-items:center;gap:7px;margin-top:13px;padding:9px;border:1px solid var(--l);border-radius:8px;color:var(--m); }.settings-summary svg:last-child { margin-left:auto; }
.stage-open { --x0:0px;--y0:-700px;--z0:.92;--x1:-150px;--y1:-13px;--z1:.9; }.stage-text { --x0:-150px;--y0:-13px;--z0:.9;--x1:-125px;--y1:-245px;--z1:.9; }.stage-generate { --x0:-125px;--y0:-245px;--z0:.9;--x1:-125px;--y1:-580px;--z1:.9; }.stage-save { --x0:-125px;--y0:-580px;--z0:.9;--x1:-350px;--y1:-645px;--z1:.93; }
@keyframes camera-pan { 0%,22% { transform:translate(var(--x0),var(--y0)) scale(var(--z0)); } 54%,90% { transform:translate(var(--x1),var(--y1)) scale(var(--z1)); } 100% { transform:translate(var(--x0),var(--y0)) scale(var(--z0)); } }@keyframes menu-leave { 0%,22% { opacity:1; } 38%,100% { opacity:0; } }@keyframes pointer-tap { 0%,8%,23%,100% { opacity:0;transform:translate(6px,6px); } 12%,18% { opacity:1;transform:none; } }
@keyframes text-before { 0%,25% { opacity:1; } 41%,100% { opacity:0; } }@keyframes text-after { 0%,25% { opacity:0; } 41%,100% { opacity:1; } }
@keyframes generate-tap { 0%,12%,31%,100% { box-shadow:none; } 18%,25% { box-shadow:0 0 0 5px color-mix(in srgb,var(--a) 22%,transparent); } }@keyframes busy-actions { 0%,24%,65%,100% { opacity:0; } 35%,56% { opacity:1; } }@keyframes progress-show { 0%,24%,65%,100% { opacity:0; } 35%,56% { opacity:1; } }@keyframes progress-fill { 0%,25% { transform:scaleX(0); } 58%,100% { transform:scaleX(1); } }@keyframes history-show { 0%,59% { opacity:0; } 74%,100% { opacity:1; } }@keyframes save-tap { 0%,65%,85%,100% { box-shadow:none; } 71%,79% { box-shadow:0 0 0 5px color-mix(in srgb,var(--a) 22%,transparent); } }
html:has(#docs-pause-motion:checked) .camera *, html:has(#docs-pause-motion:checked) .camera *::before, html:has(#docs-pause-motion:checked) .camera *::after { animation:none!important; }html:has(#docs-pause-motion:checked) .camera .canvas { transform:translate(var(--x1),var(--y1)) scale(var(--z1)); }html:has(#docs-pause-motion:checked) .camera .menu,html:has(#docs-pause-motion:checked) .camera .pointer,html:has(#docs-pause-motion:checked) .camera .model-before,html:has(#docs-pause-motion:checked) .camera .text-before,html:has(#docs-pause-motion:checked) .camera .busy-actions,html:has(#docs-pause-motion:checked) .camera .progress { opacity:0; }html:has(#docs-pause-motion:checked) .camera .model-after,html:has(#docs-pause-motion:checked) .camera .text-after,html:has(#docs-pause-motion:checked) .camera .history { opacity:1; }
@media(prefers-reduced-motion:reduce) { .camera *, .camera *::before, .camera *::after { animation:none!important; }.canvas { transform:translate(var(--x1),var(--y1)) scale(var(--z1)); }.menu,.pointer,.model-before,.text-before,.busy-actions,.progress { opacity:0; }.model-after,.text-after,.history { opacity:1; } }
@media(max-width:560px) { .camera { height:316px; }.stage-open { --x0:0px;--x1:-138px;--z1:.84; }.stage-text { --x0:-138px;--z0:.84;--x1:-155px;--y1:-230px;--z1:.85; }.stage-generate { --x0:-125px;--y0:-230px;--z0:.85;--x1:-160px;--y1:-585px;--z1:.85; }.stage-save { --x0:-125px;--y0:-548px;--z0:.85;--x1:-478px;--y1:-635px;--z1:.86; } }
.model-before,.model-after,.text-before,.text-after,.busy-actions,.progress,.history,.suggestion-action,.generate,.download { animation:none; }
.stage-open .canvas { --xf:-150px;animation:open-camera 10s ease-in-out infinite; }
.stage-open .suggestion-action { animation:open-suggestion-tap 10s linear infinite; }
.stage-open .suggestion-download { opacity:1;animation:open-download-label 10s linear infinite; }
.stage-open .suggestion-use { opacity:0;animation:open-use-label 10s linear infinite; }
.stage-open .model-before { animation:open-model-before 10s linear infinite; }
.stage-open .model-after { animation:open-model-after 10s linear infinite; }
.stage-text .model-before,.stage-generate .model-before,.stage-save .model-before { opacity:0; }
.stage-text .model-after,.stage-generate .model-after,.stage-save .model-after { opacity:1; }
.stage-text .text-before { animation:text-before 10s linear infinite; }
.stage-text .text-after { animation:text-after 10s linear infinite; }
.stage-generate .text-before,.stage-save .text-before { opacity:0; }
.stage-generate .text-after,.stage-save .text-after { opacity:1; }
.stage-generate .generate { animation:generate-tap 10s linear infinite; }
.stage-generate .busy-actions { animation:busy-actions 10s linear infinite; }
.stage-generate .progress { animation:progress-show 10s linear infinite; }
.stage-generate .history { animation:history-show 10s linear infinite; }
.stage-save .history { opacity:1; }
.stage-save .download { animation:save-tap 10s linear infinite; }
@keyframes open-camera { 0%,17% { transform:translate(var(--x0),var(--y0)) scale(var(--z0)); } 35%,60% { transform:translate(var(--xf),var(--y1)) scale(var(--z1)); } 74%,90% { transform:translate(var(--x1),var(--y1)) scale(var(--z1)); } 100% { transform:translate(var(--x0),var(--y0)) scale(var(--z0)); } }
@keyframes open-suggestion-tap { 0%,38%,64%,100% { box-shadow:none; } 42%,47%,55%,60% { box-shadow:0 0 0 5px color-mix(in srgb,var(--a) 22%,transparent); } }
@keyframes open-download-label { 0%,48% { opacity:1; } 51%,100% { opacity:0; } }
@keyframes open-use-label { 0%,48% { opacity:0; } 51%,100% { opacity:1; } }
@keyframes open-model-before { 0%,53% { opacity:1; } 65%,100% { opacity:0; } }
@keyframes open-model-after { 0%,53% { opacity:0; } 65%,100% { opacity:1; } }
html:has(#docs-pause-motion:checked) .camera.stage-open .text-before { opacity:1; }
html:has(#docs-pause-motion:checked) .camera.stage-open .text-after,
html:has(#docs-pause-motion:checked) .camera.stage-open .history,
html:has(#docs-pause-motion:checked) .camera.stage-text .history { opacity:0; }
@media(prefers-reduced-motion:reduce) {
  .stage-open .text-before { opacity:1; }
  .stage-open .text-after,.stage-open .history,.stage-text .history { opacity:0; }
}
@media(max-width:560px) {
  .stage-open .canvas { --xf:-138px; }
  .stage-text { --x0:-138px;--x1:-125px; }
  .stage-generate { --x0:-125px;--x1:-125px; }
  .stage-generate .canvas { animation:generate-camera 10s ease-in-out infinite; }
  .stage-generate .busy-actions { width:320px;flex-wrap:wrap; }
  .stage-save { --x0:-125px;--x1:-550px; }
}
@keyframes generate-camera { 0%,22% { transform:translate(var(--x0),var(--y0)) scale(var(--z0)); } 35%,56% { transform:translate(-255px,-360px) scale(var(--z0)); } 74%,90% { transform:translate(var(--x1),var(--y1)) scale(var(--z1)); } 100% { transform:translate(var(--x0),var(--y0)) scale(var(--z0)); } }
.stage-text .canvas { --ym:-145px;--yl:-360px;animation:text-camera 10s ease-in-out infinite; }
.model-field,.language-field { position:relative; }
.model-field { z-index:3; }
.language-field { z-index:2; }
.model-popup,.language-popup { position:absolute;top:100%;left:0;z-index:5;border:1px solid var(--l);border-radius:11px;background:var(--p);box-shadow:0 12px 26px #0004;opacity:0;transform:translateY(-7px) scaleY(.94);transform-origin:top left; }
.model-popup { width:340px;padding:5px;animation:audio-model-popup 10s linear infinite; }
.popup-search { display:flex;align-items:center;gap:8px;padding:8px;border-bottom:1px solid var(--l);color:var(--m);font-size:11px; }
.popup-search span { flex:1;padding:6px;border:1px solid var(--l);border-radius:6px;background:var(--f); }
.popup-model { display:flex;align-items:center;justify-content:space-between;gap:9px;padding:11px 8px;border-radius:6px;color:var(--a);font-weight:700;animation:audio-model-highlight 10s linear infinite; }
.language-popup { display:grid;width:280px;padding:5px;animation:audio-language-popup 10s linear infinite; }
.language-popup > * { display:flex;align-items:center;justify-content:space-between;min-height:31px;padding:6px 9px;border-radius:6px;font-weight:500; }
.language-popup strong { color:var(--a);font-weight:750;animation:audio-language-highlight 10s linear infinite; }
.stage-text .model-field .select-field { animation:audio-model-focus 10s linear infinite; }
.stage-text .language-field .select-field { animation:audio-language-focus 10s linear infinite; }
.stage-text .model-field .select-field > svg { animation:audio-model-chevron 10s linear infinite; }
.stage-text .language-field .select-field > svg { animation:audio-language-chevron 10s linear infinite; }
@keyframes text-camera { 0%,11% { transform:translate(var(--x0),var(--y0)) scale(var(--z0)); } 22%,38% { transform:translate(var(--x1),var(--ym)) scale(var(--z1)); } 52%,70% { transform:translate(var(--x1),var(--yl)) scale(var(--z1)); } 80%,90% { transform:translate(var(--x1),var(--y1)) scale(var(--z1)); } 100% { transform:translate(var(--x0),var(--y0)) scale(var(--z0)); } }
@keyframes audio-model-popup { 0%,18%,41%,100% { opacity:0;transform:translateY(-7px) scaleY(.94); } 24%,36% { opacity:1;transform:none; } }
@keyframes audio-language-popup { 0%,48%,76%,100% { opacity:0;transform:translateY(-7px) scaleY(.94); } 55%,70% { opacity:1;transform:none; } }
@keyframes audio-model-highlight { 0%,26% { background:transparent; } 31%,100% { background:color-mix(in srgb,var(--a) 12%,var(--p)); } }
@keyframes audio-language-highlight { 0%,61% { background:transparent; } 66%,100% { background:color-mix(in srgb,var(--a) 12%,var(--p)); } }
@keyframes audio-model-focus { 0%,17%,42%,100% { border-color:var(--l);box-shadow:none; } 22%,37% { border-color:var(--a);box-shadow:0 0 0 3px color-mix(in srgb,var(--a) 16%,transparent); } }
@keyframes audio-language-focus { 0%,49%,76%,100% { border-color:var(--l);box-shadow:none; } 54%,71% { border-color:var(--a);box-shadow:0 0 0 3px color-mix(in srgb,var(--a) 16%,transparent); } }
@keyframes audio-model-chevron { 0%,18%,41%,100% { transform:none; } 24%,36% { transform:rotate(180deg); } }
@keyframes audio-language-chevron { 0%,48%,76%,100% { transform:none; } 55%,70% { transform:rotate(180deg); } }
html:has(#docs-pause-motion:checked) .camera .model-popup,
html:has(#docs-pause-motion:checked) .camera .language-popup { opacity:0; }
@media(prefers-reduced-motion:reduce) { .model-popup,.language-popup { opacity:0; } }
@media(max-width:560px) { .model-popup { width:296px; } }
html:has(#docs-pause-motion:checked) .camera .suggestion-download { opacity:0; }
html:has(#docs-pause-motion:checked) .camera .suggestion-use { opacity:1; }
@media(prefers-reduced-motion:reduce) {
  .camera .suggestion-download { opacity:0; }
  .camera .suggestion-use { opacity:1; }
}
@media(max-width:560px) {
  .catalog { width:320px; }
  .suggestion { flex-wrap:wrap; }
  .stage-text { --y1:-255px; }
  .stage-generate { --y0:-255px;--y1:-610px; }
  .stage-save { --y0:-573px;--y1:-660px; }
}
</style>
