export const PromptApiStatus__less_than_required_free_space_on_browser_profile_volume = ({ browser, gigabytes }: { browser: string; gigabytes: number }): string => (
  `包含 ${browser} 配置文件的卷上可用空间少于 ${gigabytes} GB。`
);
