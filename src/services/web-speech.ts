/**
 * Web Speech API Service
 *
 * Provides text-to-speech functionality with support for pause/resume
 * and incremental streaming for ongoing message generation.
 */
import { reactive } from 'vue';

export type WebSpeechStatus = 'inactive' | 'playing' | 'paused' | 'waiting';

export type SpeechLanguage = 'auto' | 'en-US' | 'ja-JP' | 'ko-KR' | 'zh-CN' | 'ru-RU' | 'es-ES' | 'fr-FR' | 'de-DE';

export interface WebSpeechState {
  status: WebSpeechStatus;
  activeMessageId: string | null;
  detectedLang: string | null;
  preferredLang: SpeechLanguage;
}

class WebSpeechService {
  private synth: SpeechSynthesis | null = typeof window !== 'undefined' ? window.speechSynthesis : null;
  private currentUtterance: SpeechSynthesisUtterance | null = null;
  private readPointer = 0;
  private isExpectingMore = false;
  private lastDetectedMessageId: string | null = null;

  public readonly state = reactive<WebSpeechState>({
    status: 'inactive',
    activeMessageId: null,
    detectedLang: null,
    preferredLang: 'auto',
  });

  constructor() {
    if (typeof window !== 'undefined') {
      window.addEventListener('beforeunload', () => this.stop());
    }
  }

  public setPreferredLang({ lang }: { lang: SpeechLanguage }) {
    this.state.preferredLang = lang;
  }

  public isSupported(): boolean {
    return !!this.synth;
  }

  private updateState({ status, messageId = null }: { status: WebSpeechStatus; messageId?: string | null }) {
    this.state.status = status;
    switch (status) {
    case 'playing':
    case 'paused':
    case 'waiting':
      this.state.activeMessageId = messageId || this.state.activeMessageId;
      break;
    case 'inactive':
      this.state.activeMessageId = null;
      break;
    default: {
      const _ex: never = status;
      throw new Error(`Unhandled status: ${_ex}`);
    }
    }
  }

  private detectLanguage({ text, messageId }: { text: string; messageId: string }): string {
    // If we already detected the language for this message, reuse it
    if (this.lastDetectedMessageId === messageId && this.state.detectedLang) {
      return this.state.detectedLang;
    }

    const cleanText = text.replace(/```[\s\S]*?```/g, '').replace(/`[^`]*`/g, '');
    let lang = 'en-US';
    if (/[\u3040-\u309f\u30a0-\u30ff]/.test(cleanText)) lang = 'ja-JP';
    else if (/[\uac00-\ud7af\u1100-\u11ff]/.test(cleanText)) lang = 'ko-KR';
    else if (/[\u4e00-\u9faf]/.test(cleanText)) lang = 'zh-CN';
    else if (/[\u0400-\u04ff]/.test(cleanText)) lang = 'ru-RU';
    else if (/[áéíóúüñ¿¡]/i.test(cleanText)) lang = 'es-ES';
    else if (/[àâçéèêëîïôûùüÿœæ]/i.test(cleanText)) lang = 'fr-FR';
    else if (/[äöüß]/i.test(cleanText)) lang = 'de-DE';

    this.lastDetectedMessageId = messageId;
    this.state.detectedLang = lang;
    return lang;
  }

  /**
   * Manually trigger a fresh detection for a message, bypassing cache.
   */
  public redetectLanguage({ text, messageId }: { text: string; messageId: string }): string {
    this.lastDetectedMessageId = null;
    this.state.detectedLang = null;
    return this.detectLanguage({ text, messageId });
  }

  private prepareText({ text }: { text: string }): string {
    return text
      .replace(/<think>[\s\S]*?<\/think>/gi, '')
      .replace(/```[\s\S]*?```/g, ' [Code block] ')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/[*_~#]/g, '')
      .replace(/[:：]\s*/g, '. ')
      .replace(/[➔➜➡➢➤•●○]/g, ', ')
      .replace(/\n\s*\n/g, '. ')
      .replace(/\n/g, ', ')
      .replace(/\.{2,}/g, '.')
      .replace(/,{2,}/g, ',')
      .replace(/\s{2,}/g, ' ')
      .trim();
  }

  /**
   * Main entry point for speaking. Handles both new messages and streaming updates.
   */
  public speak({ text, messageId, isFinal, lang }: { text: string; messageId: string; isFinal: boolean; lang: SpeechLanguage }) {
    if (!this.synth) return;
    this.isExpectingMore = !isFinal;

    const resolvedLang = (() => {
      switch (lang) {
      case 'auto':
        return (this.lastDetectedMessageId === messageId && this.state.detectedLang)
          ? this.state.detectedLang
          : this.detectLanguage({ text, messageId });
      case 'en-US':
      case 'ja-JP':
      case 'ko-KR':
      case 'zh-CN':
      case 'ru-RU':
      case 'es-ES':
      case 'fr-FR':
      case 'de-DE':
        return lang;
      default: {
        const _ex: never = lang;
        return _ex;
      }
      }
    })();
    // 1. Resume if it was just paused
    if (this.state.activeMessageId === messageId && this.state.status === 'paused') {
      this.synth.resume();
      this.updateState({ status: 'playing' });
      return;
    }

    // 2. Incremental update if it's already playing the same message
    if (this.state.activeMessageId === messageId && (this.state.status === 'playing' || this.state.status === 'waiting')) {
      const queued = this.enqueueStreamingPart({ text, messageId, isFinal, resolvedLang });
      if (!queued && isFinal) {
        // If nothing was queued and it's final, we are done
        this.updateState({ status: 'inactive' });
      } else if (!queued && !isFinal && this.state.status !== 'playing') {
        // If nothing was queued and we expect more, ensure we are in waiting state if not playing
        this.updateState({ status: 'waiting' });
      }
      return;
    }

    // 3. Start fresh for a new message or restart
    this.stop();
    this.readPointer = 0;
    this.isExpectingMore = !isFinal; // restore after stop()
    const queued = this.enqueueStreamingPart({ text, messageId, isFinal, resolvedLang });
    if (!queued) {
      if (isFinal) {
        this.updateState({ status: 'inactive' });
      } else {
        this.updateState({ status: 'waiting', messageId });
      }
    }
  }

  /**
   * Returns true if an utterance was actually queued.
   */
  private enqueueStreamingPart({ text, messageId, isFinal, resolvedLang }: { text: string; messageId: string; isFinal: boolean; resolvedLang: string }): boolean {
    if (!this.synth) return false;

    const fullCleanedText = this.prepareText({ text });
    if (!fullCleanedText) return false;

    // Get the part we haven't queued yet
    const pendingText = fullCleanedText.slice(this.readPointer);
    if (!pendingText) return false;

    let textToQueue = '';

    if (isFinal) {
      // If the stream is finished, queue everything left
      textToQueue = pendingText;
      this.readPointer = fullCleanedText.length;
    } else {
      // Find the last sentence boundary in the pending text
      // We look for . ! ? or newlines followed by space or end of string
      const boundaryRegex = /.*?[.!?。\n]+(?=\s|$)/g;
      const matches = [...pendingText.matchAll(boundaryRegex)];

      if (matches.length > 0) {
        const lastMatch = matches[matches.length - 1]!;
        const endOfLastSentence = lastMatch.index! + lastMatch[0].length;
        textToQueue = pendingText.slice(0, endOfLastSentence);
        this.readPointer += endOfLastSentence;
      } else {
        // No complete sentence yet, wait for more content
        return false;
      }
    }

    if (!textToQueue.trim()) return false;

    const utterance = new SpeechSynthesisUtterance(textToQueue);
    utterance.lang = resolvedLang;

    utterance.onstart = () => {
      this.updateState({ status: 'playing', messageId });
      this.currentUtterance = utterance;
    };

    utterance.onend = () => {
      if (this.currentUtterance === utterance) {
        // Check if there's absolutely nothing left in the synth queue
        // Note: synth.pending doesn't always work reliably, so we rely on status logic
        if (!this.synth?.pending) {
          if (this.isExpectingMore) {
            this.updateState({ status: 'waiting' });
          } else {
            this.updateState({ status: 'inactive' });
            this.currentUtterance = null;
          }
        }
      }
    };

    utterance.onerror = (event) => {
      switch (event.error) {
      case 'interrupted': return;
      default:
        console.error('SpeechSynthesisUtterance error', event);
        this.updateState({ status: 'inactive' });
      }
    };

    this.synth.speak(utterance);
    return true;
  }

  public pause() {
    if (!this.synth) return;
    this.synth.pause();
    this.updateState({ status: 'paused' });
  }

  public stop() {
    if (!this.synth) return;
    this.synth.cancel();
    this.readPointer = 0;
    this.isExpectingMore = false;
    this.updateState({ status: 'inactive', messageId: null });
    this.currentUtterance = null;
  }
}

export const webSpeechService = new WebSpeechService();
