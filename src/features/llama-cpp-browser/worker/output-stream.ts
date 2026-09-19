/** Incremental stop matching and Harmony channel framing. No model text is logged. */
export function createOutputStream({ stops, harmony, initialChannel }: {
  stops: string[], harmony: boolean, initialChannel: 'analysis' | 'final',
}) {
  let pendingStop = ''; let pendingMarkup = ''; let header: string | undefined;
  let channel = initialChannel; let thinkingOpen = false; let stopped = false;
  function emitText({ text }: { text: string }): string {
    if (!text) return '';
    if (channel === 'analysis' && !thinkingOpen) {
      thinkingOpen = true; return '<think>' + text;
    }
    if (channel === 'final' && thinkingOpen) {
      thinkingOpen = false; return '</think>' + text;
    }
    return text;
  }
  function format({ text, final }: { text: string, final: boolean }): string {
    if (!harmony) return text;
    pendingMarkup += text; let out = '';
    while (pendingMarkup) {
      const begin = pendingMarkup.indexOf('<|');
      if (begin < 0) {
        const held = !final && pendingMarkup.endsWith('<') ? 1 : 0;
        const ordinary = pendingMarkup.slice(0, pendingMarkup.length - held);
        if (header === undefined) out += emitText({ text: ordinary }); else header += ordinary;
        pendingMarkup = held ? '<' : ''; break;
      }
      const ordinary = pendingMarkup.slice(0, begin);
      if (header === undefined) out += emitText({ text: ordinary }); else header += ordinary;
      pendingMarkup = pendingMarkup.slice(begin);
      const end = pendingMarkup.indexOf('|>');
      if (end < 0) {
        if (final) {
          if (header === undefined) out += emitText({ text: pendingMarkup }); pendingMarkup = '';
        }
        break;
      }
      const marker = pendingMarkup.slice(0, end + 2); pendingMarkup = pendingMarkup.slice(end + 2);
      switch (marker) {
      case '<|start|>': header = ''; break;
      case '<|channel|>': header = ''; break;
      case '<|message|>':
        channel = header?.trim() === 'analysis' ? 'analysis' : 'final'; header = undefined; break;
      case '<|end|>':
      case '<|return|>':
      case '<|fim_suffix|>':
      case '<|im_end|>':
        break;
      default:
        if (header === undefined) out += emitText({ text: marker }); else header += marker;
      }
    }
    return out;
  }
  return {
    push({ text }: { text: string }): { text: string, done: boolean } {
      if (stopped) return { text: '', done: true };
      pendingStop += text;
      let stopIndex = -1;
      for (const stop of stops) {
        if (!stop) continue;
        const index = pendingStop.indexOf(stop);
        if (index >= 0 && (stopIndex < 0 || index < stopIndex)) stopIndex = index;
      }
      if (stopIndex >= 0) {
        const output = format({ text: pendingStop.slice(0, stopIndex), final: false });
        pendingStop = ''; stopped = true; return { text: output, done: true };
      }
      let held = 0;
      for (const stop of stops) {
        for (let size = Math.min(stop.length - 1, pendingStop.length); size > held; size--) {
          if (pendingStop.endsWith(stop.slice(0, size))) {
            held = size; break;
          }
        }
      }
      const safe = pendingStop.slice(0, pendingStop.length - held);
      pendingStop = held ? pendingStop.slice(-held) : '';
      return { text: format({ text: safe, final: false }), done: false };
    },
    finish(): string {
      let out = format({ text: pendingStop, final: true }); pendingStop = '';
      if (thinkingOpen) {
        out += '</think>'; thinkingOpen = false;
      }
      return out;
    },
  };
}
export const TEST_ONLY = {
};
