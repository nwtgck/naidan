/**
 * Incremental streaming parser for the OpenAI Harmony response format.
 * @see https://developers.openai.com/cookbook/articles/openai-harmony.md
 * @see https://huggingface.co/spaces/webml-community/GPT-OSS-WebGPU/blob/main/src/utils/harmony.ts
 */

const SPECIAL_TOKENS = {
  START: "<|start|>",
  END: "<|end|>",
  MESSAGE: "<|message|>",
  CHANNEL: "<|channel|>",
  CONSTRAIN: "<|constrain|>",
  RETURN: "<|return|>",
  CALL: "<|call|>",
} as const;

const State = {
  /** Before any message — waiting for <|start|> or <|channel|> (first msg implicit start) */
  IDLE: "IDLE",
  /** After <|start|>, collecting role (and optional "to=..." recipient) */
  HEADER_ROLE: "HEADER_ROLE",
  /** After <|channel|>, collecting channel name (+ optional "to=..." recipient) */
  HEADER_CHANNEL: "HEADER_CHANNEL",
  /** After <|constrain|>, collecting content type constraint */
  HEADER_CONSTRAIN: "HEADER_CONSTRAIN",
  /** After <|message|>, collecting message body content */
  CONTENT: "CONTENT",
} as const;

type State = (typeof State)[keyof typeof State];

export interface HarmonyMessage {
    /** "assistant", "user", "system", "developer", "tool", or tool name */
    role: string;
    /** "final" | "analysis" | "commentary" | "" */
    channel: string;
    /** accumulated textual content */
    content: string;
    /** e.g. "functions.get_current_weather" */
    recipient?: string;
    /** e.g. "json" (from <|constrain|>) */
    contentType?: string;
    /** how the message ended */
    endReason: "end" | "return" | "call" | "pending";
}

export type HarmonyDelta =
    | {
        type: "new_message";
        messageIndex: number;
        message: HarmonyMessage;
    }
    | {
        type: "content";
        messageIndex: number;
        textDelta: string;
    }
    | {
        type: "done";
        messageIndex: number;
        endReason: "end" | "return" | "call";
        isDone: boolean;
    };

export class HarmonyStreamParser {
  messages: HarmonyMessage[] = [];
  private _state: State = State.IDLE;
  private _buf: string = "";
  private _done: boolean = false;

  private get _current(): HarmonyMessage | undefined {
    return this.messages.at(-1);
  }

  private _newMessage(init?: Partial<HarmonyMessage>): HarmonyDelta {
    const msg: HarmonyMessage = {
      role: "",
      channel: "",
      content: "",
      endReason: "pending",
      ...init,
    };
    this.messages.push(msg);
    return {
      type: "new_message",
      messageIndex: this.messages.length - 1,
      message: { ...msg },
    };
  }

  private _closeMessage(reason: "end" | "return" | "call"): HarmonyDelta {
    const msg = this._current;
    if (msg) {
      msg.content = msg.content.trimEnd();
      msg.endReason = reason;
    }
    this._state = State.IDLE;
    this._buf = "";
    return {
      type: "done",
      messageIndex: this.messages.length - 1,
      endReason: reason,
      isDone: reason === "return",
    };
  }

  private _extractRecipient(text: string): string {
    const match = text.match(/\bto=(\S+)/);
    if (match && this._current) {
      this._current.recipient = match[1];
      return text.replace(match[0], "").trim();
    }
    return text.trim();
  }

  push(token: string): HarmonyDelta | null {
    if (this._done) return null;

    switch (token) {
    case SPECIAL_TOKENS.START:
      this._buf = "";
      this._state = State.HEADER_ROLE;
      if (!this._current || this._current.endReason !== "pending") {
        return this._newMessage();
      }
      return null;

    case SPECIAL_TOKENS.CHANNEL:
      this._buf = "";
      this._state = State.HEADER_CHANNEL;
      if (!this._current || this._current.endReason !== "pending") {
        return this._newMessage({ role: "assistant" });
      }
      return null;

    case SPECIAL_TOKENS.CONSTRAIN:
      this._buf = "";
      this._state = State.HEADER_CONSTRAIN;
      return null;

    case SPECIAL_TOKENS.MESSAGE:
      this._buf = "";
      this._state = State.CONTENT;
      return null;

    case SPECIAL_TOKENS.END:
      return this._closeMessage("end");

    case SPECIAL_TOKENS.RETURN:
      this._done = true;
      return this._closeMessage("return");

    case SPECIAL_TOKENS.CALL:
      return this._closeMessage("call");
    }

    switch (this._state) {
    case State.HEADER_ROLE: {
      this._buf += token;
      const cleaned = this._extractRecipient(this._buf);
      if (this._current) this._current.role = cleaned;
      return null;
    }

    case State.HEADER_CHANNEL: {
      this._buf += token;
      const cleaned = this._extractRecipient(this._buf);
      if (this._current) this._current.channel = cleaned;
      return null;
    }

    case State.HEADER_CONSTRAIN: {
      this._buf += token;
      if (this._current) this._current.contentType = this._buf.trim();
      return null;
    }

    case State.CONTENT: {
      if (this._current) {
        this._current.content += token;
      }
      return {
        type: "content",
        messageIndex: this.messages.length - 1,
        textDelta: token,
      };
    }

    default:
      return null;
    }
  }

  pushMany(tokens: string[]): HarmonyDelta[] {
    const deltas: HarmonyDelta[] = [];
    for (const token of tokens) {
      const d = this.push(token);
      if (d) deltas.push(d);
    }
    return deltas;
  }

  getResult(): { messages: HarmonyMessage[]; done: boolean } {
    return {
      messages: this.messages,
      done: this._done,
    };
  }

  reset(): void {
    this.messages = [];
    this._state = State.IDLE;
    this._buf = "";
    this._done = false;
  }
}
