export const GenerationSpeed__measured_units = ({ unit }: { unit: 'tokens' | 'characters' }): string => ({ tokens: "Tokens medidos", characters: "Caracteres recibidos" }[unit]);
