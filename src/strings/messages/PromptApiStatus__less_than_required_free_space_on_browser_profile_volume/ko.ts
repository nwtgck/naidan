export const PromptApiStatus__less_than_required_free_space_on_browser_profile_volume = ({ browser, gigabytes }: { browser: string; gigabytes: number }): string => (
  `${browser} 프로필이 있는 볼륨의 여유 공간이 ${gigabytes}GB 미만입니다.`
);
