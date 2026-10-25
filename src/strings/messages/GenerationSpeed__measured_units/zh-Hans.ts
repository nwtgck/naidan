export const GenerationSpeed__measured_units = ({ unit }: { unit: 'tokens' | 'characters' }): string => ({ tokens: "测量词元数", characters: "接收字符数" }[unit]);
