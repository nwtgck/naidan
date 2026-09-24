import { describe, expect, it, vi } from 'vitest';
import { reloadPWAPage } from './reload-page';

describe('full document reload', () => {
  it.each(['https://example.test/naidan/', 'https://example.test/naidan/?keep=1#/chat/42'])('uses reload, even at unchanged %s', href => {
    const location = { href, reload: vi.fn() };
    const history = { state: { keep: true }, replaceState: vi.fn() };
    reloadPWAPage({ location, history });
    expect(location.reload).toHaveBeenCalledOnce();
    expect(history.replaceState).not.toHaveBeenCalled();
  });
  it('still reloads when optional legacy marker cleanup is denied', () => {
    const location = { href: 'https://example.test/naidan/?__naidan_update=old#/chat/42', reload: vi.fn() };
    const history = { state: null, replaceState: vi.fn(() => {
      throw new DOMException('blocked', 'SecurityError');
    }) };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      reloadPWAPage({ location, history });
      expect(location.reload).toHaveBeenCalledOnce();
      expect(warn).toHaveBeenCalledOnce();
    } finally {
      warn.mockRestore();
    }
  });
  it('removes the obsolete marker without losing query, route, or history state', () => {
    const location = { href: 'https://example.test/naidan/?keep=1&__naidan_update=old#/chat/42', reload: vi.fn() };
    const history = { state: { keep: true }, replaceState: vi.fn() };
    reloadPWAPage({ location, history });
    expect(history.replaceState).toHaveBeenCalledWith(history.state, '', 'https://example.test/naidan/?keep=1#/chat/42');
    expect(location.reload).toHaveBeenCalledOnce();
    expect(history.replaceState.mock.invocationCallOrder[0]).toBeLessThan(location.reload.mock.invocationCallOrder[0]!);
  });
});
