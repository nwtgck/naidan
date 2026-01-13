import { describe, it, expect, beforeEach } from 'vitest';
import { useOPFSExplorer } from './useOPFSExplorer';

describe('useOPFSExplorer', () => {
  beforeEach(() => {
    const { isOPFSOpen } = useOPFSExplorer();
    isOPFSOpen.value = false;
  });

  it('should initialize with isOPFSOpen as false', () => {
    const { isOPFSOpen } = useOPFSExplorer();
    expect(isOPFSOpen.value).toBe(false);
  });

  it('should open OPFS explorer', () => {
    const { isOPFSOpen, openOPFS } = useOPFSExplorer();
    openOPFS();
    expect(isOPFSOpen.value).toBe(true);
  });

  it('should close OPFS explorer', () => {
    const { isOPFSOpen, openOPFS, closeOPFS } = useOPFSExplorer();
    openOPFS();
    closeOPFS();
    expect(isOPFSOpen.value).toBe(false);
  });

  it('should toggle OPFS explorer', () => {
    const { isOPFSOpen, toggleOPFS } = useOPFSExplorer();
    toggleOPFS();
    expect(isOPFSOpen.value).toBe(true);
    toggleOPFS();
    expect(isOPFSOpen.value).toBe(false);
  });
});
