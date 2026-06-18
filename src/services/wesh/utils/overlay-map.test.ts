import { describe, expect, it, vi } from 'vitest';
import { WeshOverlayMap } from './overlay-map';

describe('WeshOverlayMap', () => {
  it('reads through the source until the first mutation and then isolates changes', () => {
    const source = new Map<string, string>([['a', '1']]);
    const overlay = new WeshOverlayMap({ source });

    source.set('b', '2');
    expect([...overlay]).toEqual([['a', '1'], ['b', '2']]);

    overlay.set('a', 'changed');
    source.set('c', '3');
    overlay.delete('b');

    expect([...source]).toEqual([['a', '1'], ['b', '2'], ['c', '3']]);
    expect([...overlay]).toEqual([['a', 'changed']]);
  });

  it('implements Map insertion helpers without replacing existing undefined values', () => {
    const source = new Map<string, string | undefined>([['present', undefined]]);
    const overlay = new WeshOverlayMap({ source });
    const compute = vi.fn(() => 'computed');

    expect(overlay.getOrInsert('present', 'default')).toBeUndefined();
    expect(overlay.getOrInsert('missing', 'default')).toBe('default');
    expect(overlay.getOrInsertComputed('present', compute)).toBeUndefined();
    expect(overlay.getOrInsertComputed('computed', compute)).toBe('computed');
    expect(compute).toHaveBeenCalledTimes(1);
  });

  it('supports clear, iteration, and forEach with itself as the Map argument', () => {
    const overlay = new WeshOverlayMap({
      source: new Map<string, number>([['a', 1], ['b', 2]]),
    });
    const seen: Array<[string, number]> = [];

    overlay.forEach((value, key, map) => {
      expect(map).toBe(overlay);
      seen.push([key, value]);
    });
    expect(seen).toEqual([['a', 1], ['b', 2]]);

    overlay.clear();
    expect(overlay.size).toBe(0);
    expect([...overlay.keys()]).toEqual([]);
    expect([...overlay.values()]).toEqual([]);
  });
});
