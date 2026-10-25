export const GenerationSpeed__measured_units = ({ unit }: { unit: 'tokens' | 'characters' }): string => ({ tokens: "측정 대상 토큰 수", characters: "수신 문자 수" }[unit]);
