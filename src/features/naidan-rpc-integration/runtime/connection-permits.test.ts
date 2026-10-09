import { expect, it } from 'vitest';
import { RpcConnectionPermits } from './connection-permits';

it('holds two complete request pairs per origin while independent servers remain usable', async () => {
  const pool = new RpcConnectionPermits(), signal = new AbortController().signal;
  const one = await pool.acquire({ origin: 'https://relay.invalid', signal, mode: 'background' }).ready;
  const two = await pool.acquire({ origin: 'https://relay.invalid/', signal, mode: 'explicit' }).ready;
  const waiting = pool.acquire({ origin: 'https://relay.invalid:443', signal, mode: 'background' });
  let ready = false; void waiting.ready.then(() => {
    ready = true;
  }); waiting.promote();
  const elsewhere = await pool.acquire({ origin: 'https://other.invalid', signal, mode: 'explicit' }).ready;
  expect(ready).toBe(false); one(); await waiting.ready; expect(ready).toBe(true);
  two(); (await waiting.ready)(); elsewhere();
});

it('canceled queued admissions and repeated release cannot free a live connection twice', async () => {
  const pool = new RpcConnectionPermits(), signal = new AbortController().signal, stopped = new AbortController();
  const first = await pool.acquire({ origin: 'https://relay.invalid', signal, mode: 'explicit' }).ready;
  const second = await pool.acquire({ origin: 'https://relay.invalid', signal, mode: 'explicit' }).ready;
  const canceled = pool.acquire({ origin: 'https://relay.invalid', signal: stopped.signal, mode: 'background' });
  stopped.abort(new Error('stop')); await expect(canceled.ready).rejects.toThrow('stop'); canceled.promote();
  first(); first();
  const third = await pool.acquire({ origin: 'https://relay.invalid', signal, mode: 'explicit' }).ready;
  let admitted = false;
  const fourth = pool.acquire({ origin: 'https://relay.invalid', signal, mode: 'explicit' }); void fourth.ready.then(() => {
    admitted = true;
  });
  await Promise.resolve(); expect(admitted).toBe(false); second(); (await fourth.ready)(); third();
});
