export const GenerationSpeed__measured_units = ({ unit }: { unit: 'tokens' | 'characters' }): string => ({ tokens: "Gemessene Tokens", characters: "Empfangene Zeichen" }[unit]);
