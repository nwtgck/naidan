export const llamaCppPerformance__image_residency = ({ value }: { value: 'cold' | 'warm' }): string => ({ cold: 'Image: initial load', warm: 'Image: resident' }[value]);
