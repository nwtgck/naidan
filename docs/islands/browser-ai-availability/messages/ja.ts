
export const messages = {
  check_this_browser_heading: 'このブラウザで確認',
  browser_scope: 'この結果は、いまこのページを開いているブラウザのものです。別のブラウザで確認するには、そのブラウザでこのURLを開いてください。',
  not_checked_yet: 'まだ確認していません。JavaScriptが有効な場合、読み込み後に確認します。',
  checking_browser_model: 'このブラウザの文字用言語モデルを確認しています…',
  browser_model_available: 'このブラウザは、文字用言語モデルを利用可能と報告しています。',
  browser_model_downloadable: 'このブラウザは、文字用モデルをダウンロード可能と報告しています。このページではダウンロードを始めません。',
  browser_model_downloading: 'このブラウザは、文字用モデルをダウンロード中と報告しています。このページでは進捗を追跡しません。',
  browser_model_unavailable: 'このブラウザは、文字用言語モデルを利用できないと報告しています。',
  language_model_api_is_not_exposed: 'Naidanに必要なLanguageModel APIがこのブラウザでは見つかりません。これだけで端末の非対応とは判断できません。',
  unrecognized_browser_status: 'ブラウザから未対応の状態が返ったため、利用可否を確認できません。',
  browser_check_failed: 'ブラウザから確認結果を取得できませんでした。もう一度お試しください。',
  check_again: '再確認',
  availability_check_limits: 'この確認はモデルを準備せず、すべての言語や設定で回答できることも保証しません。',
} satisfies typeof import('./en').messages;
