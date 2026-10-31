import "server-only";

import type { ToolContext } from "../kit";

// Background work started by other tools: its progress, cancelling and retrying (jobauto fork).

/** Registers these tools on the connector's server. */
export function registerTaskTools(context: ToolContext): void {
  void context;
}
