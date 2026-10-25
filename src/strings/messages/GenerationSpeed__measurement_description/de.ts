export const GenerationSpeed__measurement_description = ({ measurement }: { measurement: 'ollama_eval' | 'llama_cpp_predicted' | 'worker_sample_interval' | 'client_request' | 'received_text' }): string => ({
  ollama_eval: "Ausgabemenge und Generierungszeit von Ollama. Ohne Werkzeugausführung und Eingabeverarbeitung.",
  llama_cpp_predicted: "Generierungsmesswerte von llama.cpp server. Ohne Werkzeugausführung und Eingabeverarbeitung.",
  worker_sample_interval: "Token-Abtastintervalle im Worker, ohne erstes Token und End-Tokens. Einschließlich Laufzeit- und Übertragungsaufwand, nicht nur nativer Rechenzeit.",
  client_request: "Ungefähre effektive Tokenrate aus gemeldeter Nutzung und Anfragedauer. Mit Wartezeit, Eingabeverarbeitung, Netzwerk und Client; keine reine Decodiergeschwindigkeit.",
  received_text: "Ungefähre Empfangsrate in Unicode-Codepoints, einschließlich Denktext und gestreamter Werkzeugargumente, sofern verfügbar. Mit Netzwerk- und Clientverzögerungen; keine Tokenrate.",
}[measurement]);
