import { describe, expect, it } from 'vitest';
import { createOutputStream } from './output-stream';

describe('llama.cpp output stream', () => {
  it('preserves ordinary text and explicit think markup without Harmony', () => {
    const stream = createOutputStream({ stops: [], harmony: false, initialChannel: 'final' });
    expect(stream.push({ text: '<think>reason</think>Hello 🌟' })).toEqual({ text: '<think>reason</think>Hello 🌟', done: false });
    expect(stream.finish()).toBe('');
  });
  it('does not expose stop text split over chunks', () => {
    const stream = createOutputStream({ stops: ['STOP'], harmony: false, initialChannel: 'final' });
    expect(stream.push({ text: 'before ST' })).toEqual({ text: 'before ', done: false });
    expect(stream.push({ text: 'OPignored' })).toEqual({ text: '', done: true });
    expect(stream.push({ text: 'more' })).toEqual({ text: '', done: true });
    expect(stream.finish()).toBe('');
  });
  it('flushes an incomplete stop prefix at normal completion', () => {
    const stream = createOutputStream({ stops: ['stop'], harmony: false, initialChannel: 'final' });
    expect(stream.push({ text: 'hello st' }).text).toBe('hello ');
    expect(stream.finish()).toBe('st');
  });
  it('uses the earliest complete stop regardless of list order', () => {
    const stream = createOutputStream({ stops: ['', 'later', 'early'], harmony: false, initialChannel: 'final' });
    expect(stream.push({ text: 'a early and later' })).toEqual({ text: 'a ', done: true });
  });
  const wire = '<|start|>assistant<|channel|>analysis<|message|>reason 🌟<|end|><|start|>assistant<|channel|>final<|message|>answer<|return|>';
  it.each(Array.from({ length: wire.length + 1 }, (_, split) => ({ split })))('frames Harmony when split at $split', ({ split }) => {
    const stream = createOutputStream({ stops: [], harmony: true, initialChannel: 'final' });
    const first = stream.push({ text: wire.slice(0, split) });
    const second = stream.push({ text: wire.slice(split) });
    expect(first.text + second.text + stream.finish()).toBe('<think>reason 🌟</think>answer');
  });
  it('handles a template that has already opened the analysis channel', () => {
    const stream = createOutputStream({ stops: [], harmony: true, initialChannel: 'analysis' });
    expect(stream.push({ text: 'why' }).text).toBe('<think>why');
    expect(stream.finish()).toBe('</think>');
    expect(stream.finish()).toBe('');
  });
  it('continues an analysis header already supplied by the prompt template', () => {
    const stream = createOutputStream({ stops: [], harmony: true, initialChannel: 'final' });
    expect(stream.push({ text: '<|start|>assistant<|channel|>analysis' }).text).toBe('');
    expect(stream.push({ text: '<|message|>reason' }).text).toBe('<think>reason');
    expect(stream.push({ text: '<|end|><|start|>assistant<|channel|>final<|message|>answer' }).text).toBe('</think>answer');
    expect(stream.finish()).toBe('');
  });
  it('closes an open thinking section after a stop sequence', () => {
    const stream = createOutputStream({ stops: ['halt'], harmony: true, initialChannel: 'analysis' });
    expect(stream.push({ text: 'reason haltignored' })).toEqual({ text: '<think>reason ', done: true });
    expect(stream.finish()).toBe('</think>');
  });
  it('preserves unknown tags and unfinished literal markup outside headers', () => {
    const stream = createOutputStream({ stops: [], harmony: true, initialChannel: 'final' });
    expect(stream.push({ text: 'x<|unknown|>y<' }).text).toBe('x<|unknown|>y');
    expect(stream.finish()).toBe('<');
  });
});
