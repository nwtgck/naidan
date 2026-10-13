import { boundaryComparisonJa } from '../work/boundary/demo/ja';
import { standaloneDemoJa } from '../run/standalone/demo/ja';
import { storageChoiceDemoJa } from './storage-demo/ja';
import type { HomeMessages } from '../../site/messages';

export const strings = {
  standaloneDemo: standaloneDemoJa,
  storageDemo: storageChoiceDemoJa,
  "demo": {
    "title": "プロジェクトの要約",
    "user": "あなた",
    "prompt": "明日の予定を箇条書きにして。試作品の確認、残りの作業の確認、次の改善の準備。",
    "answerIntro": "明日の予定をまとめます。",
    "answerItems": [
      "試作品を確認する。",
      "残りの作業を確認する。",
      "次の改善に向けて準備する。"
    ],
    "placeholder": "メッセージを入力...",
    "capabilities": [
      "テキスト生成",
      "画像生成",
      "音声生成"
    ],
  },
  boundary: boundaryComparisonJa,
  "title": "ブラウザで使うAI環境と、データを守る仕組み",
  "headline": [
    "安全性を徹底追求した、",
    "簡単に使えるAI環境。"
  ],
  "description": "Naidanはブラウザで会話・画像生成・音声生成ができるAI環境です。端末内で動くモデル、ファイルの権限、会話の保存方法を選ぶ使い方を紹介します。",
  "intro": [
    "AIに資料を渡す際、外部へ送ってよいかをその都度判断する。安全に使い続けるための負担を、使う人の注意深さだけに任せたくありません。",
    "目指したのは、危険な操作が起こりにくい環境を、誰もが簡単に使えること。その考えから生まれたのがNaidanです。"
  ],
  "howTitle": "ブラウザが持つ境界を、そのまま活かす。",
  "howLead": "普段のブラウザを、AIやツールを動かすための制限付きの実行環境として使います。ファイル、クリップボード、通信へのアクセスには、ブラウザのAPIと許可の仕組みを通ります。",
  "mechanisms": [
    {
      "title": "アクセスできる範囲をブラウザが制御",
      "body": "ブラウザのサンドボックスは、ファイルやデバイス機能へのアクセスを制限します。選んだファイルやフォルダも、許可した範囲で扱います。",
    },
    {
      "title": "入力を端末内のモデルで処理",
      "body": "テキスト・画像・音声のモデルをブラウザ内で実行できます。対応する実行環境ではWebGPUを利用し、端末のグラフィックス処理能力を推論に活用します。",
    },
    {
      "title": "通信する範囲も選べる",
      "body": "Local-only版はContent Security Policy（CSP）で接続先をサイト自身とローカルサーバーに限定します。ブラウザの開発者ツールから通信の内容を確認することもできます。",
    }
  ],
  "boundaryNote": "モデルの取得時は配信元と通信します。外部のエンジンやToolを選ぶ場合は、その実行環境の権限と通信先も含めて使い方を選べます。",
  "modelsTitle": "AIモデルの実行方法を選ぶ。",
  "models": [
    {
      "title": "ブラウザ内で実行する",
      "body": "対応するモデルを取得し、端末内で生成します。使えるモデルや処理速度はブラウザと端末の性能によって変わります。",
    },
    {
      "title": "ローカルのエンジンに接続する",
      "body": "Naidanと独立して動くOllamaやllama.cpp serverにもAPIで接続できます。モデルの対応範囲や速度を重視したいときの選択肢です。これらはネイティブプロセスの権限で動作します。",
    }
  ],
  storageCaption: 'Local StorageはOPFSを使えない場合の選択肢です。容量と送信画像の保存に制限があります。',
  "storageTitle": "会話を保存するか、メモリだけで扱うか。",
  "storageLead": "会話データをブラウザの保存領域へ記録するかを選べます。",
  "storage": [
    {
      "title": "ブラウザの保存領域に記録",
      "body": "Origin Private File System（OPFS）を利用し、会話や添付ファイルをブラウザ専用の保存領域に記録します。次に開いたときも続きから使えます。",
    },
    {
      "title": "メモリだけで使う",
      "body": "Memory方式は、会話データを永続保存せず、実行中のメモリに保持します。ページを再読み込みすると、そのセッションのデータは失われます。",
    }
  ],
  "storageNote": "この設定はNaidanの会話データの保持方法を選ぶものです。モデルのキャッシュ、書き出したファイル、OSのメモリ管理は別に扱われます。",
  "standalone": { "title": "ダブルクリックで、AIを使い始める。", "body": "Standalone版のZIPを展開したら、PCでindex.htmlをダブルクリック。インストーラーや画面を配信するサーバーを用意せず、ブラウザで開けます。その後、使うモデルやローカルエンジンを選びます。" },
  "standaloneLink": "インストーラーや配信用サーバーなしで使う",
  "guidesTitle": "知りたい機能から探す",
  "guidesLead": "関心のあるガイドから読み始められます。使い方と、選ぶ際に知っておきたい点を一緒に説明します。",
  "guides": {
    "files": {
      "title": "AIが読み書きできるファイルを選ぶ",
      "body": "フォルダのリンクとコピー、読み取り・書き込み権限の違いを説明します。",
    },
    "boundary": {
      "title": "ブラウザ内AIの処理とアクセス権限を確認する",
      "body": "ブラウザの権限制限と端末内の処理を図で確認します。",
    },
    "branching": {
      "title": "AIとの会話を自由に分岐・編集する",
      "body": "元の会話を残しながら、前のメッセージの編集、別の回答、別のチャットへの分岐を試せます。",
    },
    "shell": {
      "title": "ブラウザ内のシェルでAIにファイル操作を任せる",
      "body": "選んだファイルの検索をAIに頼み、使ったコマンドと結果を確認できます。",
    },
  },
} satisfies HomeMessages;
