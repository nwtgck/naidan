import { describe, expect, it } from 'vitest';
import { resolveWikipediaSearchLanguages } from './language-routing';

describe('resolveWikipediaSearchLanguages', () => {
  it('routes kana to ja and en', () => {
    expect(resolveWikipediaSearchLanguages({ query: '量子コンピュータのしくみ', contextLanguage: undefined })).toEqual(['ja', 'en']);
  });

  it('routes hangul to ko and en', () => {
    expect(resolveWikipediaSearchLanguages({ query: '양자 컴퓨터', contextLanguage: undefined })).toEqual(['ko', 'en']);
  });

  it('routes thai to th and en', () => {
    expect(resolveWikipediaSearchLanguages({ query: 'คอมพิวเตอร์ควอนตัม', contextLanguage: undefined })).toEqual(['th', 'en']);
  });

  it('routes hebrew to he and en', () => {
    expect(resolveWikipediaSearchLanguages({ query: 'מחשב קוונטי', contextLanguage: undefined })).toEqual(['he', 'en']);
  });

  it('routes greek to el and en', () => {
    expect(resolveWikipediaSearchLanguages({ query: 'κβαντικός υπολογιστής', contextLanguage: undefined })).toEqual(['el', 'en']);
  });

  it('routes cyrillic with uk context to uk and en', () => {
    expect(resolveWikipediaSearchLanguages({ query: 'квантовий комп’ютер', contextLanguage: 'uk' })).toEqual(['uk', 'en']);
  });

  it('routes cyrillic without context to ru and en', () => {
    expect(resolveWikipediaSearchLanguages({ query: 'квантовый компьютер', contextLanguage: undefined })).toEqual(['ru', 'en']);
  });

  it('routes arabic script with fa context to fa and en', () => {
    expect(resolveWikipediaSearchLanguages({ query: 'رایانش کوانتومی', contextLanguage: 'fa' })).toEqual(['fa', 'en']);
  });

  it('routes arabic script without context to ar and en', () => {
    expect(resolveWikipediaSearchLanguages({ query: 'حوسبة كمية', contextLanguage: undefined })).toEqual(['ar', 'en']);
  });

  it('routes han with ja context to ja and en', () => {
    expect(resolveWikipediaSearchLanguages({ query: '量子計算', contextLanguage: 'ja' })).toEqual(['ja', 'en']);
  });

  it('routes han with zh context to zh and en', () => {
    expect(resolveWikipediaSearchLanguages({ query: '量子计算', contextLanguage: 'zh' })).toEqual(['zh', 'en']);
  });

  it('routes han without context to zh and en', () => {
    expect(resolveWikipediaSearchLanguages({ query: '量子计算', contextLanguage: undefined })).toEqual(['zh', 'en']);
  });

  it('routes latin text with de context to de and en', () => {
    expect(resolveWikipediaSearchLanguages({ query: 'quantum computer', contextLanguage: 'de' })).toEqual(['de', 'en']);
  });

  it('routes latin text with en context to en only', () => {
    expect(resolveWikipediaSearchLanguages({ query: 'quantum computer', contextLanguage: 'en' })).toEqual(['en']);
  });

  it('routes latin text without context to en only', () => {
    expect(resolveWikipediaSearchLanguages({ query: 'quantum computer', contextLanguage: undefined })).toEqual(['en']);
  });

  it('returns at most two languages and removes duplicates', () => {
    expect(resolveWikipediaSearchLanguages({ query: '量子コンピュータ', contextLanguage: 'ja' })).toEqual(['ja', 'en']);
  });
});
