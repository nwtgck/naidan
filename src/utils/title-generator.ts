/**
 * Supported languages for title generation, ordered by approximate speaker count/relevance.
 */
export type SupportedLanguage =
  | 'en' // English
  | 'zh' // Chinese
  | 'hi' // Hindi
  | 'es' // Spanish
  | 'fr' // French
  | 'ar' // Arabic
  | 'bn' // Bengali
  | 'pt' // Portuguese
  | 'ru' // Russian
  | 'ur' // Urdu
  | 'id' // Indonesian
  | 'de' // German
  | 'ja' // Japanese
  | 'ko' // Korean
  | 'it' // Italian
  | 'vi' // Vietnamese
  | 'tr' // Turkish
  | 'th'; // Thai

/**
 * Detects the language of the content using lightweight heuristics (Unicode ranges).
 * Priorities:
 * 1. Strong content signals (unique scripts like Kana, Hangul, etc.)
 * 2. Fallback to browser/system language provided in options
 * 3. Default to English
 */
export function detectLanguage({ content, fallbackLanguage = 'en' }: { content: string; fallbackLanguage?: string }): SupportedLanguage {
  const sample = content.slice(0, 500); // Analyze first 500 chars

  // 1. Check for specific scripts (High confidence)

  // Japanese: Hiragana (\u3040-\u309F) or Katakana (\u30A0-\u30FF)
  // Check this BEFORE Chinese because Japanese also uses Hanzi (Kanji)
  if (/[\u3040-\u309F\u30A0-\u30FF]/.test(sample)) {
    return 'ja';
  }

  // Korean: Hangul Syllables (\uAC00-\uD7AF)
  if (/[\uAC00-\uD7AF]/.test(sample)) {
    return 'ko';
  }

  // Cyrillic (Russian, Ukrainian, etc.): \u0400-\u04FF
  // Simple heuristic: map to 'ru' for title generation purposes
  if (/[\u0400-\u04FF]/.test(sample)) {
    return 'ru';
  }

  // Arabic: \u0600-\u06FF
  if (/[\u0600-\u06FF]/.test(sample)) {
    return 'ar';
  }

  // Devanagari (Hindi, etc.): \u0900-\u097F
  if (/[\u0900-\u097F]/.test(sample)) {
    return 'hi';
  }

  // Bengali: \u0980-\u09FF
  if (/[\u0980-\u09FF]/.test(sample)) {
    return 'bn';
  }

  // Thai: \u0E00-\u0E7F
  if (/[\u0E00-\u0E7F]/.test(sample)) {
    return 'th';
  }

  // Chinese: Hanzi (CJK Unified Ideographs) \u4E00-\u9FFF
  // Checked AFTER Japanese to ensure mixed Japanese text is caught as 'ja'
  if (/[\u4E00-\u9FFF]/.test(sample)) {
    return 'zh';
  }

  // 2. Fallback to provided locale (e.g. navigator.language)
  if (fallbackLanguage) {
    const code = fallbackLanguage.split('-')[0]?.toLowerCase();
    // Check if the code is in our supported list
    const supported: Set<string | undefined> = new Set([
      'en', 'zh', 'hi', 'es', 'fr', 'ar', 'bn', 'pt', 'ru', 'ur',
      'id', 'de', 'ja', 'ko', 'it', 'vi', 'tr', 'th'
    ]);

    if (code && supported.has(code)) {
      return code as SupportedLanguage;
    }
  }

  // 3. Default
  return 'en';
}

const SYSTEM_PROMPTS: Record<SupportedLanguage, string> = {
  en: "Identify the main topic of this conversation in 3-5 words. Output ONLY the topic.",
  zh: "总结对话的核心主题。仅输出主题，10字以内。",
  hi: "इस बातचीत का मुख्य विषय 3-5 शब्दों में लिखें। केवल विषय लिखें।",
  es: "Identifica el tema principal de esta conversación en 3-5 palabras. Salida SOLO el tema.",
  fr: "Identifiez le sujet principal de cette conversation en 3-5 mots. Sortie UNIQUEMENT le sujet.",
  ar: "حدد الموضوع الرئيسي لهذه المحادثة في 3-5 كلمات. أخرج الموضوع فقط.",
  bn: "এই কথোপকথনের মূল বিষয়টি ৩-৫ শব্দে লিখুন। শুধুমাত্র বিষয়টি লিখুন।",
  pt: "Identifique o tópico principal desta conversa em 3-5 palavras. Saída APENAS o tópico.",
  ru: "Определите главную тему этого разговора в 3-5 словах. Выведите ТОЛЬКО тему.",
  ur: "اس گفتگو کا مرکزی موضوع 3-5 الفاظ میں لکھیں۔ صرف موضوع لکھیں۔",
  id: "Identifikasi topik utama percakapan ini dalam 3-5 kata. Keluarkan HANYA topiknya.",
  de: "Nennen Sie das Hauptthema dieses Gesprächs in 3-5 Wörtern. Ausgabe NUR das Thema.",
  ja: "この会話の「主題」を推測し、一言で表してください。タイトル：「〜」の形式は不要です。15文字以内で出力してください。",
  ko: "이 대화의 핵심 주제를 10자 이내로 요약하세요. 주제만 출력하세요.",
  it: "Identifica l'argomento principale di questa conversazione in 3-5 parole. Output SOLO l'argomento.",
  vi: "Xác định chủ đề chính của cuộc trò chuyện này trong 3-5 từ. CHỈ xuất chủ đề.",
  tr: "Bu konuşmanın ana konusunu 3-5 kelimeyle belirtin. SADECE konuyu çıktı verin.",
  th: "ระบุหัวข้อหลักของการสนทนานี้เป็นคำสั้นๆ ไม่เกิน 5 คำ ส่งออกเฉพาะหัวข้อเท่านั้น"
};

/**
 * Gets the system prompt for title generation based on the language.
 */
export function getTitleSystemPrompt(lang: SupportedLanguage): string {
  return SYSTEM_PROMPTS[lang] || SYSTEM_PROMPTS['en'];
}

/**
 * Cleans the generated title by removing common prefixes and quotes.
 */
export function cleanGeneratedTitle(title: string): string {
  return title
    .trim()
    .replace(/^["']|["']$/g, '') // Remove surrounding quotes
    .trim()
    .replace(/^(Title|Subject|Topic|Theme|Heres a title|Here is a title|タイトル|件名|主題)[:：]\s*/i, '') // Remove prefixes
    .trim();
}
