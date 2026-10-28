export const llamaCppPerformance__image_residency = ({ value }: { value: 'cold' | 'warm' }): string => ({ cold: '画像：初回の読み込み', warm: '画像：読み込み済み' }[value]);
