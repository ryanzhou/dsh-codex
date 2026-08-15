import type { Context } from "@deepseek-ai/cordis";
import { installGrammarBridge } from "./pi-ai.js";
import { installPresetRoot } from "./presets.js";

export const name = "dsh-codex";
export const inject = ["agentPresets"];

export function apply(ctx: Context): void {
  installGrammarBridge();
  ctx.effect(() => installPresetRoot(ctx.agentPresets));
}
