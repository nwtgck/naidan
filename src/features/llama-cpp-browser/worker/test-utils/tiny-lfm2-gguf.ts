/**
 * A self-authored, untrained GGUF exercising llama.cpp's LFM2 architecture.
 * All weights and the byte vocabulary are synthetic; no published model,
 * tokenizer, or chat-template artifacts are copied or redistributed here.
 */
export function createTinyLfm2Gguf(): Uint8Array {
  function join({ parts }: { parts: Uint8Array[] }): Uint8Array {
    const result = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
    let offset = 0;
    for (const part of parts) {
      result.set(part, offset);
      offset += part.length;
    }
    return result;
  }
  function u32({ value }: { value: number }): Uint8Array {
    const bytes = new Uint8Array(4);
    new DataView(bytes.buffer).setUint32(0, value, true);
    return bytes;
  }
  function u64({ value }: { value: number }): Uint8Array {
    const bytes = new Uint8Array(8);
    new DataView(bytes.buffer).setBigUint64(0, BigInt(value), true);
    return bytes;
  }
  function f32({ value }: { value: number }): Uint8Array {
    const bytes = new Uint8Array(4);
    new DataView(bytes.buffer).setFloat32(0, value, true);
    return bytes;
  }
  function text({ value }: { value: string }): Uint8Array {
    const bytes = new TextEncoder().encode(value);
    return join({ parts: [u64({ value: bytes.length }), bytes] });
  }
  function entry({ name, type, data }: { name: string, type: number, data: Uint8Array }): Uint8Array {
    return join({ parts: [text({ value: name }), u32({ value: type }), data] });
  }
  function array({ type, values }: { type: number, values: Uint8Array[] }): Uint8Array {
    return join({ parts: [u32({ value: type }), u64({ value: values.length }), ...values] });
  }

  const embedding = 16;
  const feedForward = 32;
  const vocab = ['<unk>', '<s>', '</s>', ...Array.from({ length: 256 }, (_, index) => `<0x${index.toString(16).toUpperCase().padStart(2, '0')}>`)];
  const metadata: Uint8Array[] = [];
  for (const [name, value] of [
    ['general.architecture', 'lfm2'],
    ['general.name', 'untrained native hybrid checkpoint fixture'],
    ['tokenizer.ggml.model', 'llama'],
  ] satisfies [string, string][]) {
    metadata.push(entry({ name, type: 8, data: text({ value }) }));
  }
  for (const [name, value] of [
    ['lfm2.context_length', 256],
    ['lfm2.embedding_length', embedding],
    ['lfm2.block_count', 2],
    ['lfm2.feed_forward_length', feedForward],
    ['lfm2.rope.dimension_count', embedding],
    ['lfm2.shortconv.l_cache', 3],
    ['tokenizer.ggml.bos_token_id', 1],
    ['tokenizer.ggml.eos_token_id', 2],
    ['tokenizer.ggml.unknown_token_id', 0],
  ] satisfies [string, number][]) {
    metadata.push(entry({ name, type: 4, data: u32({ value }) }));
  }
  // The zero head count selects LFM2's recurrent layer using the native GGUF contract.
  for (const name of ['lfm2.attention.head_count', 'lfm2.attention.head_count_kv']) {
    metadata.push(entry({ name, type: 9, data: array({ type: 4, values: [u32({ value: 1 }), u32({ value: 0 })] }) }));
  }
  metadata.push(entry({ name: 'lfm2.attention.layer_norm_rms_epsilon', type: 6, data: f32({ value: 1e-5 }) }));
  metadata.push(entry({ name: 'tokenizer.ggml.add_space_prefix', type: 7, data: new Uint8Array([0]) }));
  metadata.push(entry({ name: 'tokenizer.ggml.tokens', type: 9, data: array({ type: 8, values: vocab.map(value => text({ value })) }) }));
  metadata.push(entry({ name: 'tokenizer.ggml.scores', type: 9, data: array({ type: 6, values: vocab.map(() => f32({ value: 0 })) }) }));
  metadata.push(entry({ name: 'tokenizer.ggml.token_type', type: 9, data: array({ type: 5, values: vocab.map((_, index) => u32({ value: index === 0 ? 2 : index < 3 ? 3 : 6 })) }) }));

  const shapes: [string, number[]][] = [
    ['token_embd.weight', [embedding, vocab.length]],
    ['token_embd_norm.weight', [embedding]],
    ['output.weight', [embedding, vocab.length]],
    ['blk.0.attn_q_norm.weight', [embedding]],
    ['blk.0.attn_k_norm.weight', [embedding]],
    ['blk.0.attn_q.weight', [embedding, embedding]],
    ['blk.0.attn_k.weight', [embedding, embedding]],
    ['blk.0.attn_v.weight', [embedding, embedding]],
    ['blk.0.attn_output.weight', [embedding, embedding]],
    ['blk.1.shortconv.conv.weight', [3, embedding]],
    ['blk.1.shortconv.in_proj.weight', [embedding, 3 * embedding]],
    ['blk.1.shortconv.out_proj.weight', [embedding, embedding]],
  ];
  for (const layer of [0, 1]) {
    shapes.push(
      [`blk.${layer}.attn_norm.weight`, [embedding]],
      [`blk.${layer}.ffn_norm.weight`, [embedding]],
      [`blk.${layer}.ffn_gate.weight`, [embedding, feedForward]],
      [`blk.${layer}.ffn_up.weight`, [embedding, feedForward]],
      [`blk.${layer}.ffn_down.weight`, [feedForward, embedding]],
    );
  }

  const descriptors: Uint8Array[] = [];
  const payload: Uint8Array[] = [];
  let offset = 0;
  for (const [name, shape] of shapes) {
    const aligned = Math.ceil(offset / 32) * 32;
    payload.push(new Uint8Array(aligned - offset));
    offset = aligned;
    descriptors.push(join({ parts: [text({ value: name }), u32({ value: shape.length }), ...shape.map(value => u64({ value })), u32({ value: 0 }), u64({ value: offset })] }));
    const bytes = new Uint8Array(shape.reduce((left, right) => left * right, 1) * 4);
    const view = new DataView(bytes.buffer);
    if (name.includes('norm.weight')) {
      for (let index = 0; index < bytes.length; index += 4) view.setFloat32(index, 1, true);
    }
    if (name === 'token_embd.weight') {
      for (let token = 0; token < vocab.length; token++) {
        view.setFloat32(token * embedding * 4, 1, true);
        view.setFloat32((token * embedding + 1) * 4, token % 2 === 0 ? 0.5 : -0.5, true);
      }
    }
    if (name === 'output.weight') {
      view.setFloat32((68 * embedding + 1) * 4, 1, true);
      view.setFloat32((69 * embedding + 1) * 4, -1, true);
    }
    // Q/K remain zero, so attention uniformly averages the retained prefix.
    if (name === 'blk.0.attn_v.weight' || name === 'blk.0.attn_output.weight') {
      for (let index = 0; index < embedding; index++) view.setFloat32((index * embedding + index) * 4, 0.5, true);
    }
    if (name === 'blk.1.shortconv.in_proj.weight') {
      for (let index = 0; index < embedding; index++) {
        // B and C gates read the nonzero constant coordinate; X reads each input coordinate.
        view.setFloat32(index * embedding * 4, 0.5, true);
        view.setFloat32((embedding + index) * embedding * 4, 0.5, true);
        view.setFloat32(((2 * embedding + index) * embedding + index) * 4, 0.5, true);
      }
    }
    if (name === 'blk.1.shortconv.conv.weight') {
      for (let index = 0; index < embedding; index++) {
        view.setFloat32((index * 3) * 4, 0.8, true);
        view.setFloat32((index * 3 + 1) * 4, 0.7, true);
        view.setFloat32((index * 3 + 2) * 4, 0.2, true);
      }
    }
    if (name === 'blk.1.shortconv.out_proj.weight') {
      for (let index = 0; index < embedding; index++) view.setFloat32((index * embedding + index) * 4, 0.75, true);
    }
    payload.push(bytes);
    offset += bytes.length;
  }
  const header = join({ parts: [new TextEncoder().encode('GGUF'), u32({ value: 3 }), u64({ value: shapes.length }), u64({ value: metadata.length }), ...metadata, ...descriptors] });
  return join({ parts: [header, new Uint8Array((32 - header.length % 32) % 32), ...payload] });
}

export const TEST_ONLY = {
};
