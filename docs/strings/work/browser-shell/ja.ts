import type { ShellMessages } from '../../../site/messages';

export const strings = {
  "title": "ブラウザ内でシェルを使う",
  "description": "使い慣れたコマンドで、ブラウザ内のファイルや会話の内容を扱えます。",
  "intro": [
    "AIがプロジェクトを調べたり編集したりするには、シェルが役立ちます。その作業のためにPCの通常のシェルを渡す代わりに、ブラウザの中にシェル環境を用意しています。"
  ],
  "sections": [
    {
      "title": "使い慣れたコマンドをブラウザ内で実行",
      "body": "内部名をWeshというこの環境では、ファイル操作やテキスト処理、ローカルのGit操作を行えます。見えるファイルシステムは、そのChatに公開したマウントで決まります。",
    },
    {
      "title": "作業するデータを選ぶ",
      "body": "独立した作業領域やリンクしたフォルダを使い、読み取り専用か書き込み可能かを指定します。全体設定、Chat Group、Chatの設定から有効なマウントが決まります。",
    },
    {
      "title": "会話の内容もファイルとして参照",
      "body": "Naidanは、選んだChatの情報を/sys/fs/naidan以下の読み取り専用ファイルとして公開します。現在のChat、そのChat Group、メインのChat一覧のうち、どの範囲を見せるか選べます。",
    }
  ],
  "exampleTitle": "現在のChatの内容を調べる",
  "exampleNote": "現在のChatをシェルに公開した場合のパスの例です。PCのOS上のパスとは別のものです。",
  "next": "ファイルとフォルダのアクセスを選ぶ",
} satisfies ShellMessages;
