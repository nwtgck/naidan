import { describe, expect, it } from 'vitest';
import { createMemoryFiles } from './memory-files';

describe('raw download replay memory files', () => {
  it('records stat without reading the body until a stream is consumed', async () => {
    const fs = createMemoryFiles();
    fs.files.set('model.onnx', new Uint8Array([17, 23, 41]));
    fs.enter({ nextPhase: 'load', mutationPolicy: 'read-only' });
    const handle = await fs.root.getFileHandle('model.onnx');
    const file = await handle.getFile();
    const stream = file.stream();
    expect(file.size).toBe(3);
    expect(fs.activity).toEqual([{ phase: 'load', operation: 'stat', path: 'model.onnx', bytes: 3 }]);

    const reader = stream.getReader();
    expect(await reader.read()).toEqual({ done: false, value: new Uint8Array([17, 23, 41]) });
    expect(await reader.read()).toEqual({ done: true, value: undefined });
    expect(fs.activity).toEqual([
      { phase: 'load', operation: 'stat', path: 'model.onnx', bytes: 3 },
      { phase: 'load', operation: 'body-read', path: 'model.onnx', bytes: 3 },
    ]);
  });

  it('records each arrayBuffer body read with its byte length', async () => {
    const fs = createMemoryFiles();
    fs.files.set('model.onnx', new Uint8Array([17, 23, 41]));
    fs.enter({ nextPhase: 'load', mutationPolicy: 'read-only' });
    const handle = await fs.root.getFileHandle('model.onnx');
    const file = await handle.getFile();

    expect(new Uint8Array(await file.arrayBuffer())).toEqual(new Uint8Array([17, 23, 41]));
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(new Uint8Array([17, 23, 41]));
    expect(fs.activity).toEqual([
      { phase: 'load', operation: 'stat', path: 'model.onnx', bytes: 3 },
      { phase: 'load', operation: 'body-read', path: 'model.onnx', bytes: 3 },
      { phase: 'load', operation: 'body-read', path: 'model.onnx', bytes: 3 },
    ]);
  });

  it('records each text body read in bytes rather than decoded characters', async () => {
    const fs = createMemoryFiles();
    const content = 'café';
    fs.files.set('config.json', new TextEncoder().encode(content));
    fs.enter({ nextPhase: 'load', mutationPolicy: 'read-only' });
    const handle = await fs.root.getFileHandle('config.json');
    const file = await handle.getFile();

    expect(await file.text()).toBe(content);
    expect(await file.text()).toBe(content);
    expect(fs.activity).toEqual([
      { phase: 'load', operation: 'stat', path: 'config.json', bytes: 5 },
      { phase: 'load', operation: 'body-read', path: 'config.json', bytes: 5 },
      { phase: 'load', operation: 'body-read', path: 'config.json', bytes: 5 },
    ]);
  });

  it('keeps an existing File snapshot unchanged after a later write commits', async () => {
    const fs = createMemoryFiles();
    fs.files.set('model.onnx', new TextEncoder().encode('before'));
    fs.enter({ nextPhase: 'download', mutationPolicy: 'read-write' });
    const handle = await fs.root.getFileHandle('model.onnx');
    const snapshot = await handle.getFile();

    const writable = await handle.createWritable();
    const writer = writable.getWriter();
    await writer.write(new TextEncoder().encode('after'));
    await writer.close();

    expect(snapshot.size).toBe(6);
    expect(await snapshot.text()).toBe('before');
    expect(Array.from(new Uint8Array(await snapshot.arrayBuffer()))).toEqual([98, 101, 102, 111, 114, 101]);
    const reader = snapshot.stream().getReader();
    const chunk = await reader.read();
    expect(chunk.done).toBe(false);
    expect(Array.from(chunk.value!)).toEqual([98, 101, 102, 111, 114, 101]);
    expect(await reader.read()).toEqual({ done: true, value: undefined });
    const latest = await handle.getFile();
    expect(latest.size).toBe(5);
    expect(await latest.text()).toBe('after');
  });

  it('keeps the File snapshot unchanged when callers mutate returned body buffers', async () => {
    const fs = createMemoryFiles();
    fs.files.set('model.onnx', new TextEncoder().encode('before'));
    const handle = await fs.root.getFileHandle('model.onnx');
    const file = await handle.getFile();

    const buffer = new Uint8Array(await file.arrayBuffer());
    buffer.fill(0);
    expect(await file.text()).toBe('before');

    const reader = file.stream().getReader();
    const chunk = await reader.read();
    expect(chunk.done).toBe(false);
    chunk.value!.fill(0);
    expect(await file.text()).toBe('before');
    expect(Array.from(new Uint8Array(await file.arrayBuffer()))).toEqual([98, 101, 102, 111, 114, 101]);
  });
});
