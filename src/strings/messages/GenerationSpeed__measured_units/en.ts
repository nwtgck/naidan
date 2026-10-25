export const GenerationSpeed__measured_units = ({ unit }: { unit: 'tokens' | 'characters' }): string => ({ tokens: "Measured tokens", characters: "Received characters" }[unit]);
