import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock speech synthesis BEFORE importing the service
const mockSynth = {
  speak: vi.fn(),
  cancel: vi.fn(),
  pause: vi.fn(),
  resume: vi.fn(),
};

interface MockUtterance {
  text: string;
  lang: string;
  onstart: (() => void) | null;
  onend: (() => void) | null;
  onerror: ((err: any) => void) | null;
}

const mockUtterance = vi.fn().mockImplementation(function(this: MockUtterance, text: string) {
  this.text = text;
  this.lang = '';
  this.onstart = null;
  this.onend = null;
  this.onerror = null;
});

vi.stubGlobal('speechSynthesis', mockSynth);
vi.stubGlobal('SpeechSynthesisUtterance', mockUtterance);

// Now import the service
import { webSpeechService } from './web-speech';

describe('WebSpeechService', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Force set the private synth if it was initialized as null
    if (!(webSpeechService as any).synth) {
      (webSpeechService as any).synth = mockSynth;
    }

    // Reset service state
    webSpeechService.stop();
  });

  it('reports support correctly', () => {
    expect(webSpeechService.isSupported()).toBe(true);
  });

  describe('Text Preparation', () => {
    it('removes think blocks and markdown', () => {
      const text = '<think>internal</think> Hello **world**! ```code```';
      webSpeechService.speak({ text, messageId: '1' });

      const calls = mockSynth.speak.mock.calls;
      const utterance = (calls[0] as any[])?.[0] as MockUtterance | undefined;
      expect(utterance?.text).toBe('Hello world! [Code block]');
    });

    it('replaces colons with periods for pauses', () => {
      const text = 'Answer: Hello';
      webSpeechService.speak({ text, messageId: '1' });

      const calls = mockSynth.speak.mock.calls;
      const utterance = (calls[0] as any[])?.[0] as MockUtterance | undefined;
      expect(utterance?.text).toBe('Answer. Hello');
    });

    it('handles newlines with commas and periods', () => {
      const text = `Line 1
Line 2

Line 3`;
      webSpeechService.speak({ text, messageId: '1' });

      const calls = mockSynth.speak.mock.calls;
      const utterance = (calls[0] as any[])?.[0] as MockUtterance | undefined;
      expect(utterance?.text).toBe('Line 1, Line 2. Line 3');
    });
  });

  describe('Language Detection', () => {
    it('detects Japanese', () => {
      webSpeechService.speak({ text: 'こんにちは', messageId: '1' });
      const calls = mockSynth.speak.mock.calls;
      const utterance = (calls[0] as any[])?.[0] as MockUtterance | undefined;
      expect(utterance?.lang).toBe('ja-JP');
    });

    it('detects English default', () => {
      webSpeechService.speak({ text: 'Hello world', messageId: '1' });
      const calls = mockSynth.speak.mock.calls;
      const utterance = (calls[0] as any[])?.[0] as MockUtterance | undefined;
      expect(utterance?.lang).toBe('en-US');
    });

    it('detects French with accents', () => {
      webSpeechService.speak({ text: 'Comment ça va?', messageId: '1' });
      const calls = mockSynth.speak.mock.calls;
      const utterance = (calls[0] as any[])?.[0] as MockUtterance | undefined;
      expect(utterance?.lang).toBe('fr-FR');
    });
  });

  describe('State Management', () => {
    it('transitions to playing state on start', () => {
      webSpeechService.speak({ text: 'Hello', messageId: '1' });
      const calls = mockSynth.speak.mock.calls;
      const utterance = (calls[0] as any[])?.[0] as MockUtterance | undefined;

      utterance?.onstart?.();
      expect(webSpeechService.state.status).toBe('playing');
      expect(webSpeechService.state.activeMessageId).toBe('1');
    });

    it('transitions to inactive state on end', () => {
      webSpeechService.speak({ text: 'Hello', messageId: '1' });
      const calls = mockSynth.speak.mock.calls;
      const utterance = (calls[0] as any[])?.[0] as MockUtterance | undefined;

      utterance?.onstart?.();
      utterance?.onend?.();
      expect(webSpeechService.state.status).toBe('inactive');
      expect(webSpeechService.state.activeMessageId).toBe(null);
    });

    it('supports pause and resume', () => {
      webSpeechService.speak({ text: 'Hello', messageId: '1' });
      const calls = mockSynth.speak.mock.calls;
      const utterance = (calls[0] as any[])?.[0] as MockUtterance | undefined;
      utterance?.onstart?.();

      webSpeechService.pause();
      expect(mockSynth.pause).toHaveBeenCalled();
      expect(webSpeechService.state.status).toBe('paused');

      webSpeechService.speak({ text: 'Hello', messageId: '1' });
      expect(mockSynth.resume).toHaveBeenCalled();
      expect(webSpeechService.state.status).toBe('playing');
    });

    it('stops current when starting a new message', () => {
      webSpeechService.speak({ text: 'Message 1', messageId: '1' });
      expect(mockSynth.speak).toHaveBeenCalledTimes(1);

      webSpeechService.speak({ text: 'Message 2', messageId: '2' });
      expect(mockSynth.cancel).toHaveBeenCalled();
      expect(mockSynth.speak).toHaveBeenCalledTimes(2);

      const calls = mockSynth.speak.mock.calls;
      const utterance2 = (calls[1] as any[])?.[0] as MockUtterance | undefined;
      utterance2?.onstart?.();
      expect(webSpeechService.state.activeMessageId).toBe('2');
    });

    it('stops speech on browser reload (beforeunload)', () => {
      webSpeechService.speak({ text: 'Hello', messageId: '1' });
      const calls = mockSynth.speak.mock.calls;
      const utterance = (calls[0] as any[])?.[0] as MockUtterance | undefined;
      utterance?.onstart?.();
      expect(webSpeechService.state.status).toBe('playing');

      // Simulate beforeunload event
      const event = new Event('beforeunload');
      window.dispatchEvent(event);

      expect(mockSynth.cancel).toHaveBeenCalled();
      expect(webSpeechService.state.status).toBe('inactive');
    });
  });
});