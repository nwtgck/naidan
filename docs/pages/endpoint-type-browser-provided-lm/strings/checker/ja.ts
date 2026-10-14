import type { BrowserAiAvailabilityCopy } from './en';

export const strings = {
  title: 'このブラウザで確認',
  scope: 'この結果は、いまこのページを開いているブラウザのものです。別のブラウザで確認するには、そのブラウザでこのURLを開いてください。',
  initial: 'まだ確認していません。JavaScriptが有効な場合、読み込み後に確認します。',
  checking: 'このブラウザの文字用言語モデルを確認しています…',
  available: 'このブラウザは、文字用言語モデルを利用可能と報告しています。',
  downloadable: 'このブラウザは、文字用モデルをダウンロード可能と報告しています。このページではダウンロードを始めません。',
  downloading: 'このブラウザは、文字用モデルをダウンロード中と報告しています。このページでは進捗を追跡しません。',
  unavailable: 'このブラウザは、文字用言語モデルを利用できないと報告しています。',
  apiAbsent: 'Naidanに必要なLanguageModel APIがこのブラウザでは見つかりません。これだけで端末の非対応とは判断できません。',
  unknown: 'ブラウザから未対応の状態が返ったため、利用可否を確認できません。',
  rejected: 'ブラウザから確認結果を取得できませんでした。もう一度お試しください。',
  recheck: '再確認',
  limits: 'この確認はモデルを準備せず、すべての言語や設定で回答できることも保証しません。',
} satisfies BrowserAiAvailabilityCopy;
