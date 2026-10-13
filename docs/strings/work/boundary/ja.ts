import type { BoundaryMessages } from '../../../site/messages';

export const strings = {
  "title": "ブラウザによるアクセス制限",
  "description": "ブラウザに備わった権限の境界を、AIを動かす環境の土台として利用します。",
  "intro": [
    "AIに作業を任せるために必要なのは、その作業に使うデータへのアクセスです。PC全体を自由に操作できる権限とは分けて考えられます。Naidanは、ブラウザがすでに持つ境界の内側に作業環境を用意します。"
  ],
  "diagramTitle": "処理が行われる場所",
  "app": "Naidan",
  "runtime": "端末内のモデル",
  "files": "選んだファイル",
  "permission": "ブラウザの権限境界",
  "flowLabel": "ブラウザ内で処理するデータ",
  "motionLabel": "処理の流れを動かして見る",
  "motionNote": "権限の境界を簡略化した図です。実際の権限変更やモデルの実行は行いません。",
  "sections": [
    {
      "title": "ブラウザがアクセスを仲介する",
      "body": "ファイルやフォルダ、デバイス機能へのアクセスにはブラウザのAPIを使います。利用できるAPIと付与された権限によって操作の範囲が決まります。",
    },
    {
      "title": "端末内のモデルで入力を処理する",
      "body": "ブラウザ内モデルを選んだ場合、推論はその端末内で行われます。モデルを取得するときは配信元との通信が発生します。",
    },
    {
      "title": "接続先にも境界を設ける",
      "body": "Content Security Policy（CSP）で通信先をさらに制限できます。ローカルのネイティブエンジンや外部Toolを使う場合は、それぞれの実行環境の権限も関係します。",
    }
  ],
  "next": "ファイルとフォルダのアクセスを選ぶ",
} satisfies BoundaryMessages;
