/** A deterministic, untrained one-layer F32 fixture. Never used by application code. */
export function createSyntheticGguf({ chatTemplate }: { chatTemplate: string }): Uint8Array {
  function join({ parts }: { parts: Uint8Array[] }): Uint8Array {
    const result = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
    let offset = 0; for (const part of parts) {
      result.set(part, offset); offset += part.length;
    }
    return result;
  }
  function u32({ value }: { value: number }): Uint8Array {
    const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, value, true); return b;
  }
  function u64({ value }: { value: number }): Uint8Array {
    const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(value), true); return b;
  }
  function f32({ value }: { value: number }): Uint8Array {
    const b = new Uint8Array(4); new DataView(b.buffer).setFloat32(0, value, true); return b;
  }
  function text({ value }: { value: string }): Uint8Array {
    const b = new TextEncoder().encode(value); return join({ parts: [u64({ value: b.length }), b] });
  }
  function entry({ name, type, data }: { name: string, type: number, data: Uint8Array }): Uint8Array {
    return join({ parts: [text({ value: name }), u32({ value: type }), data] });
  }
  const vocab = ['<unk>', '<s>', '</s>', ...Array.from({ length: 256 }, (_, i) => `<0x${i.toString(16).toUpperCase().padStart(2, '0')}>`)];
  const metadata: Uint8Array[] = [];
  for (const [name, value] of [['general.architecture', 'llama'], ['general.name', 'untrained integration fixture'], ['tokenizer.ggml.model', 'llama'], ['tokenizer.chat_template', chatTemplate]] satisfies [string, string][]) {
    metadata.push(entry({ name, type: 8, data: text({ value }) }));
  }
  for (const [name, value] of [['llama.context_length', 256], ['llama.embedding_length', 32], ['llama.block_count', 1], ['llama.feed_forward_length', 64], ['llama.attention.head_count', 4], ['llama.attention.head_count_kv', 4], ['llama.rope.dimension_count', 8], ['tokenizer.ggml.bos_token_id', 1], ['tokenizer.ggml.eos_token_id', 2], ['tokenizer.ggml.unknown_token_id', 0]] satisfies [string, number][]) {
    metadata.push(entry({ name, type: 4, data: u32({ value }) }));
  }
  // Byte fixtures must not silently prepend a space to each separately tokenized marker.
  metadata.push(entry({ name: 'tokenizer.ggml.add_space_prefix', type: 7, data: new Uint8Array([0]) }));
  metadata.push(entry({ name: 'llama.attention.layer_norm_rms_epsilon', type: 6, data: f32({ value: 1e-5 }) }));
  metadata.push(entry({ name: 'tokenizer.ggml.tokens', type: 9, data: join({ parts: [u32({ value: 8 }), u64({ value: vocab.length }), ...vocab.map(value => text({ value }))] }) }));
  metadata.push(entry({ name: 'tokenizer.ggml.scores', type: 9, data: join({ parts: [u32({ value: 6 }), u64({ value: vocab.length }), ...vocab.map(() => f32({ value: 0 }))] }) }));
  metadata.push(entry({ name: 'tokenizer.ggml.token_type', type: 9, data: join({ parts: [u32({ value: 5 }), u64({ value: vocab.length }), ...vocab.map((_, i) => u32({ value: i === 0 ? 2 : i < 3 ? 3 : 6 }))] }) }));
  const shapes: [string, number[]][] = [
    ['token_embd.weight', [32, vocab.length]], ['output_norm.weight', [32]], ['output.weight', [32, vocab.length]],
    ['blk.0.attn_norm.weight', [32]], ['blk.0.attn_q.weight', [32, 32]], ['blk.0.attn_k.weight', [32, 32]],
    ['blk.0.attn_v.weight', [32, 32]], ['blk.0.attn_output.weight', [32, 32]], ['blk.0.ffn_norm.weight', [32]],
    ['blk.0.ffn_gate.weight', [32, 64]], ['blk.0.ffn_down.weight', [64, 32]], ['blk.0.ffn_up.weight', [32, 64]],
  ];
  const descriptors: Uint8Array[] = []; const payload: Uint8Array[] = []; let offset = 0;
  for (const [name, shape] of shapes) {
    const aligned = Math.ceil(offset / 32) * 32; payload.push(new Uint8Array(aligned - offset)); offset = aligned;
    descriptors.push(join({ parts: [text({ value: name }), u32({ value: shape.length }), ...shape.map(value => u64({ value })), u32({ value: 0 }), u64({ value: offset })] }));
    const data = new Uint8Array(shape.reduce((a, b) => a * b, 1) * 4);
    if (name.includes('norm.weight')) {
      const view = new DataView(data.buffer); for (let i = 0; i < data.length; i += 4) view.setFloat32(i, 1, true);
    }
    // Keep inference deterministic while emitting an ordinary byte token ('A').
    if (name === 'token_embd.weight') {
      const view = new DataView(data.buffer);
      for (let offset = 0; offset < data.length; offset += 32 * 4) view.setFloat32(offset, 1, true);
    }
    if (name === 'output.weight') new DataView(data.buffer).setFloat32((3 + 65) * 32 * 4, 1, true);
    payload.push(data); offset += data.length;
  }
  const header = join({ parts: [new TextEncoder().encode('GGUF'), u32({ value: 3 }), u64({ value: shapes.length }), u64({ value: metadata.length }), ...metadata, ...descriptors] });
  return join({ parts: [header, new Uint8Array((32 - header.length % 32) % 32), ...payload] });
}
export const TEST_ONLY = {
};
