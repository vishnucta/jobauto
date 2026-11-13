import "server-only";

import type { UsageSink } from "@/lib/usage";

import type { ChatAnswer, ChatCall } from "../provider";
import { OpenAICompatibleProvider } from "./openai-compatible";

/**
 * Room for a model to think before it writes. DeepSeek's thinking counts
 * towards `max_tokens`: without room on top, a long think on a resume leaves
 * none for the answer, which then comes back cut off. With it the limit is
 * 8,192, which DeepSeek's smaller models take too.
 */
const THINKING_TOKENS = 4_096;

/**
 * DeepSeek, through its OpenAI-compatible API, with room to think on top of
 * each answer. Through OpenAI-compatible, DeepSeek's API is told to answer
 * without thinking first instead (servers.ts); here its models think.
 */
export class DeepSeekProvider extends OpenAICompatibleProvider {
  constructor(baseURL: string, apiKey: string | null, model: string | null, timeoutMs: number, onUsage?: UsageSink) {
    super("DEEPSEEK", baseURL, apiKey, model, timeoutMs, onUsage);
  }

  protected override chat(call: ChatCall): Promise<ChatAnswer> {
    return super.chat({ ...call, maxTokens: call.maxTokens + THINKING_TOKENS });
  }

  /** The room for thinking is made in chat(), within what DeepSeek's smaller models take. */
  protected override thinkingRoom(): number {
    return 0;
  }

  /** The server's fields without `thinking`, which turns the thinking off. */
  protected override serverFields(): Record<string, unknown> {
    const fields = { ...super.serverFields() };
    delete fields.thinking;
    return fields;
  }
}
