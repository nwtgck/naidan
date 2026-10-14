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
  "title": "Webブラウザの中で動くAI環境",
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
      "body": "ローカルのみ版はContent Security Policy（CSP）でページのAPI通信先をサイト自身とローカルサーバーに限定します。ブラウザの開発者ツールから通信の内容を確認することもできます。",
    }
  ],
  "boundaryNote": "モデルの取得時は配信元と通信します。外部のエンジンやツールを選ぶ場合は、その実行環境の権限と通信先も含めて使い方を選べます。",
  localOnlyLink: 'ローカルのみ版の通信先と制限を詳しく見る',
  appPermissionsLink: 'Webアプリとネイティブアプリのアクセス範囲を比べる',
  appPermissionsDescription: '端末のどこにアクセスでき、得た情報をどう送れるかを比べます。',
  "modelsTitle": "AIモデルの実行方法を選ぶ。",
  "models": [
    {
      "title": "ブラウザ内で実行する",
      "body": "対応するモデルを取得または取り込み、端末内で生成します。ローカルのみ版では外部のモデルをダウンロードできないため、手元のGGUFを取り込めます。使えるモデルや処理速度はブラウザと端末の性能によって変わります。",
    },
    {
      "title": "ローカルのエンジンに接続する",
      "body": "Naidanと独立して動くOllamaやllama.cpp serverにもAPIで接続できます。モデルの対応範囲や速度を重視したいときの選択肢です。これらはネイティブプロセスの権限で動作します。",
    }
  ],
  storageCaption: '図中の「すべてのデータ」「永続データは残りません」は、会話や設定を含む、選択したNaidanのメモリ内保存先のデータを指します。',
  "storageTitle": "会話を保存するか、メモリだけで扱うか。",
  "storageLead": "会話データをブラウザの保存領域へ記録するかを選べます。",
  "storage": [
    {
      "title": "ブラウザの保存領域に記録",
      "body": "Origin Private File System（OPFS）を利用し、会話や添付ファイルをブラウザ専用の保存領域に記録します。次に開いたときも続きから使えます。",
    },
    {
      "title": "メモリだけで使う",
      "body": "一時保存方式は、会話データを永続保存せず、実行中のメモリに保持します。ページを再読み込みすると、そのセッションのデータは失われます。",
    }
  ],
  "storageNote": "この設定はNaidanが選んだ保存先に置く会話・グループ・設定・ファイルの保持方法を選ぶものです。モデルのキャッシュ、書き出したファイル、OSのメモリ管理は別に扱われます。",
  "standalone": { "title": "ダブルクリックで、AIを使い始める。", "body": "スタンドアロン版のZIPを展開したら、PCでindex.htmlをダブルクリック。インストーラーや画面を配信するサーバーを用意せず、ブラウザで開けます。その後、使うモデルやローカルエンジンを選びます。" },
  "standaloneLink": "インストーラーや配信用サーバーなしで使う",
  standaloneDescription: 'ZIPの取得から起動、モデル選びまでの手順を確認できます。',
  "guidesTitle": "知りたい機能から探す",
  "guidesLead": "関心のあるガイドから読み始められます。使い方と、選ぶ際に知っておきたい点を一緒に説明します。",
  "guides": {
    gguf: {
      title: 'GGUFモデルでチャットする',
      body: 'ブラウザで試すモデルを選び、手元のGGUFも取り込めます。',
    },
    image: {
      title: '端末内で画像を作る',
      body: 'ローカルの画像モデルで一枚作り、設定を使い直して次を試せます。',
    },
    audio: {
      title: '端末内で音声を作る',
      body: '文章から音声を生成し、再生してWAVで保存できます。',
    },
    "branching": {
      "title": "会話を分岐・編集する",
      "body": "元の会話を残して、前の発言の編集や別の回答を試せます。",
    },
    "shell": {
      "title": "AIにファイル操作を任せる",
      "body": "使わせるファイルを選び、シェルのコマンドと結果を確認できます。",
    },
    groups: {
      title: '用途別にチャットをまとめる',
      body: 'グループを作り、既存のチャットを移して次の会話を始められます。',
    },
    wikipedia: {
      title: 'チャットでWikipediaを調べる',
      body: 'Wikipediaを使う設定と、検索・記事取得の確認方法を案内します。',
    },
    offline: {
      title: 'NaidanをPWAとしてオフラインで使う',
      body: '接続中にアプリと端末内モデルを準備し、切断後の動作を確かめます。',
    },
  },
} satisfies HomeMessages;
