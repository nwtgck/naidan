/* eslint-disable no-restricted-imports -- Worker-only adapter for the native Transformers.js token stream. */
import { TextStreamer, type PreTrainedTokenizer } from '@huggingface/transformers';

/** Separates actual special tokens from ordinary text that only looks like one. */
export class NativeProtocolStreamer extends TextStreamer {
  private promptPending = true;
  private readonly nativeIds: Set<bigint>;
  private readonly decodeControl: ({ id }: { id: bigint }) => string;
  private readonly onControl: ({ token }: { token: string }) => void;

  constructor({ tokenizer, protocolTokens, onText, onControl }: {
    tokenizer: PreTrainedTokenizer,
    protocolTokens: readonly string[] | undefined,
    onText: ({ text }: { text: string }) => void,
    onControl: ({ token }: { token: string }) => void,
  }) {
    super(tokenizer, {
      skip_prompt: false,
      skip_special_tokens: false,
      callback_function: text => onText({ text }),
    });
    this.nativeIds = new Set(tokenizer.all_special_ids.map(BigInt));
    // Some model-owned delimiters are atomic added tokens with special=false.
    // Opt in only at that model's boundary; ordinary token sequences spelling
    // the same string must still go through onText without reinterpretation.
    for (const token of protocolTokens ?? []) {
      const ids = tokenizer.encode(token, { add_special_tokens: false });
      if (ids.length !== 1 || tokenizer.decode(ids, { skip_special_tokens: false }) !== token) {
        throw new Error('The tokenizer cannot identify an atomic native protocol delimiter.');
      }
      this.nativeIds.add(BigInt(ids[0]!));
    }
    this.decodeControl = ({ id }) => tokenizer.decode([id], { skip_special_tokens: false });
    this.onControl = onControl;
  }


  override put(value: bigint[][]): void {
    if (value.length !== 1) throw new Error('Native protocol streaming requires a single sequence.');
    if (this.promptPending) {
      this.promptPending = false; return;
    }
    let ordinary: bigint[] = [];
    const flushOrdinary = () => {
      if (ordinary.length > 0) {
        super.put([ordinary]); ordinary = [];
      }
    };
    for (const id of value[0]!) {
      if (this.nativeIds.has(id)) {
        flushOrdinary();
        // Flush text before the marker without marking the semantic part done.
        // skip_prompt is false on the base streamer, so its reset cannot hide
        // the first ordinary token after a marker.
        super.end();
        this.onControl({ token: this.decodeControl({ id }) });
      } else {
        ordinary.push(id);
      }
    }
    flushOrdinary();
  }

  // Preserve the native hook as an own method so capture can observe this
  // concrete streamer without modifying shared prototype methods.
  override on_finalized_text(text: string, streamEnd: boolean): void {
    super.on_finalized_text(text, streamEnd);
  }

  override end(): void {
    super.end();
    this.promptPending = true;
    // EOF alone does not establish semantic completion for a native protocol.
  }
}

export const TEST_ONLY = {
};
