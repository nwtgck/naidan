import type { Core } from 'speech-cpp-browser-core/speech-cpp/host';
import { speechCallbackPointer } from './native-memory';

type LogReceiver = ({ level, text }: { level: number, text: string }) => void;
type Router = { active: { owner: object, receive: LogReceiver } | undefined, ready: Promise<void> };
const routers = new WeakMap<Core, Router>();

/** The API cannot restore its initial stderr logger after log_set(NULL), which
 * drops logs. Keep one slot for this Worker lifetime and preserve warn/error
 * forwarding when no diagnostic operation owns the sink. */
export async function subscribeNativeSpeechLogs({ core, receive }: { core: Core, receive: LogReceiver }): Promise<() => void> {
  let router = routers.get(core);
  if (router === undefined) {
    const created: Router = { active: undefined, ready: Promise.resolve() };
    routers.set(core, created);
    router = created;
    const decoder = new TextDecoder(), warning = core.constant('SPEECH_LOG_WARN');
    try {
      const callback = core.module.addFunction((level, pointer) => {
        if (typeof level !== 'number' || (created.active === undefined && level < warning)) {
          return;
        }
        try {
          const address = speechCallbackPointer({ core, value: pointer });
          const capacity = core.module.HEAPU8.byteLength;
          if (address <= 0n || address >= BigInt(capacity)) {
            return;
          }
          const bytes = core.bytes(address, Math.min(64 * 1024, capacity - Number(address)));
          const end = bytes.indexOf(0);
          // The string is borrowed only during this callback. Copy it now.
          const text = decoder.decode(end < 0 ? bytes : bytes.subarray(0, end));
          if (level >= warning) {
            // Matches this factory's default printErr destination. Never make
            // native/ggml warnings disappear after a diagnostic operation.
            console.error(text);
          }
          created.active?.receive({ level, text });
        } catch { /* Logging must not unwind a native operation. */ }
      }, core.pointerBytes === 4 ? 'viii' : 'vijj');
      // This slot remains registered until physical Worker termination. It is
      // never freed while native could still call it, even if setup rejects.
      created.ready = core.api.speech_log_set(BigInt(callback), 0n).catch(() => {});
    } catch { /* An unavailable diagnostic logger leaves native execution alone. */ }
  }
  const owner = {};
  router.active = { owner, receive };
  await router.ready;
  return () => {
    if (router.active?.owner === owner) {
      router.active = undefined;
    }
  };
}

export const TEST_ONLY = {
};
