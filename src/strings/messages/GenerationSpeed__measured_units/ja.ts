export const GenerationSpeed__measured_units = ({ unit }: { unit: 'tokens' | 'characters' }): string => ({ tokens: "計測対象のトークン数", characters: "計測対象の受信文字数" }[unit]);
