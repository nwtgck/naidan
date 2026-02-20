import { describe, it, expect, beforeEach } from 'vitest';
import { useOverlay } from './useOverlay';

describe('useOverlay Composable', () => {
  const { activeOverlay, openOverlay, closeOverlay, toggleOverlay } = useOverlay();

  beforeEach(() => {
    closeOverlay();
  });

  it('should have initial state none', () => {
    expect(activeOverlay.value).toBe('none');
  });

  it('should open an overlay', () => {
    openOverlay({ type: 'search' });
    expect(activeOverlay.value).toBe('search');
  });

  it('should close an overlay', () => {
    openOverlay({ type: 'recent' });
    closeOverlay();
    expect(activeOverlay.value).toBe('none');
  });

  it('should toggle an overlay', () => {
    toggleOverlay({ type: 'search' });
    expect(activeOverlay.value).toBe('search');
    toggleOverlay({ type: 'search' });
    expect(activeOverlay.value).toBe('none');
  });

  it('should switch between overlays', () => {
    openOverlay({ type: 'search' });
    expect(activeOverlay.value).toBe('search');
    openOverlay({ type: 'recent' });
    expect(activeOverlay.value).toBe('recent');
  });
});
