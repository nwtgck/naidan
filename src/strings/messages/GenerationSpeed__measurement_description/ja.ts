export const GenerationSpeed__measurement_description = ({ measurement }: { measurement: 'ollama_eval' | 'llama_cpp_predicted' | 'worker_sample_interval' | 'client_request' | 'received_text' }): string => ({
  ollama_eval: "Ollamaが返した出力数と生成時間から算出しています。ツール実行と入力処理の時間は含みません。",
  llama_cpp_predicted: "llama.cpp serverの生成処理の計測値です。ツール実行と入力処理の時間は含みません。",
  worker_sample_interval: "Worker内のトークン採取間隔から算出しています。最初のトークンと生成終了トークンは除外します。実行環境や配送の待ち時間も含み、ネイティブ処理だけの速度ではありません。",
  client_request: "返されたトークン数とリクエスト時間から算出した概算の実効速度です。待機・入力処理・通信・クライアント処理を含み、生成処理だけの速度ではありません。",
  received_text: "受信テキストのUnicodeコードポイント数による概算です。取得できる思考やツール引数も数えます。通信やクライアントの遅延を含み、トークン生成速度ではありません。",
}[measurement]);
