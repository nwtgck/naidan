export const CspMessageHint__this_resource_source_is_outside_the_allowed_range = ({ url }: { url: string | undefined }): string => (
  `この読み込み元${url === undefined ? '' : `（${url}）`}は、この許可範囲に含まれていません。`
);
