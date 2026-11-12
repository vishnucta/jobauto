import "server-only";

import type { ChatAnswer, ChatCall } from "../provider";
import { OpenAICompatibleProvider } from "./openai-compatible";

/**
 * Room for a model to think before it writes. DeepSeek's thinking counts
 * towards `max_tokens`: without room on top, a long think on a resume leaves
 * none for the answer, which then comes back cut off. With it the limit is
 * 8,192, which DeepSeek's smaller models take too.
 */
const THINKING_TOKENS = 4_096;

/** DeepSeek, through its OpenAI-compatible API, with room to think on top of each answer. */
export class DeepSeekProvider extends OpenAICompatibleProvider {
  constructor(baseURL: string, apiKey: string | null, model: string | null, timeoutMs: number) {
    super("DEEPSEEK", baseURL, apiKey, model, timeoutMs);
  }

  protected override chat(call: ChatCall): Promise<ChatAnswer> {
    return super.chat({ ...call, maxTokens: call.maxTokens + THINKING_TOKENS });
  }
}
