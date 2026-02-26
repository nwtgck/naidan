import { describe, it, expect, vi, beforeEach } from 'vitest';
import { detectOllama } from './ollama-detection';

describe('detectOllama', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  it('returns true when Ollama is running', async () => {
    (fetch as any).mockResolvedValue({
      ok: true,
      text: () => Promise.resolve('Ollama is running'),
    });

    const result = await detectOllama({ url: 'http://localhost:11434' });
    expect(result).toBe(true);
    expect(fetch).toHaveBeenCalledWith('http://localhost:11434', expect.any(Object));
  });

  it('returns false when response does not contain "Ollama is running"', async () => {
    (fetch as any).mockResolvedValue({
      ok: true,
      text: () => Promise.resolve('Not found'),
    });

    const result = await detectOllama({ url: 'http://localhost:11434' });
    expect(result).toBe(false);
  });

  it('returns false when response is not ok', async () => {
    (fetch as any).mockResolvedValue({
      ok: false,
      text: () => Promise.resolve('Error'),
    });

    const result = await detectOllama({ url: 'http://localhost:11434' });
    expect(result).toBe(false);
  });

  it('returns false when fetch throws', async () => {
    (fetch as any).mockRejectedValue(new Error('Network error'));

    const result = await detectOllama({ url: 'http://localhost:11434' });
    expect(result).toBe(false);
  });

  it('passes headers correctly', async () => {
    (fetch as any).mockResolvedValue({
      ok: true,
      text: () => Promise.resolve('Ollama is running'),
    });

    await detectOllama({
      url: 'http://localhost:11434',
      headers: [['Authorization', 'Bearer token']]
    });

    expect(fetch).toHaveBeenCalledWith(
      'http://localhost:11434',
      expect.objectContaining({
        headers: {
          Authorization: 'Bearer token'
        }
      })
    );
  });
});
