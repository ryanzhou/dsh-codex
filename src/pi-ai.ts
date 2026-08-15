import { PiAiAdapter } from "@deepseek-ai/dsh-llm-pi-ai";
import { APPLY_PATCH_GRAMMAR } from "./apply-patch/grammar.js";

const PATCHED = "__dshCodexGrammarPatched" as const;
const wrapped = new WeakSet<object>();

type PiContext = { tools?: PiTool[]; [key: string]: unknown };
type PiTool = { name: string; [key: string]: unknown };
type Provider = {
  streamSimple(model: unknown, context: PiContext, options?: unknown): unknown;
};
type AdapterInternals = {
  current(): { models: { getProviders(): readonly Provider[] } };
};

export function addCodexGrammar(context: PiContext): PiContext {
  if (!context.tools?.some((tool) => tool.name === "apply_patch")) return context;
  return {
    ...context,
    tools: context.tools.map((tool) =>
      tool.name === "apply_patch"
        ? {
            ...tool,
            constrainedSampling: {
              type: "grammar",
              variants: { openai_lark: APPLY_PATCH_GRAMMAR },
            },
          }
        : tool,
    ),
  };
}

function wrapProviders(adapter: PiAiAdapter): void {
  const { models } = (adapter as unknown as AdapterInternals).current();
  for (const provider of models.getProviders()) {
    if (wrapped.has(provider)) continue;
    const streamSimple = provider.streamSimple;
    provider.streamSimple = (model, context, options) =>
      streamSimple.call(provider, model, addCodexGrammar(context), options);
    wrapped.add(provider);
  }
}

export function installGrammarBridge(): void {
  const prototype = PiAiAdapter.prototype as typeof PiAiAdapter.prototype & {
    [PATCHED]?: true;
  };
  if (prototype[PATCHED]) return;
  const stream = prototype.stream;
  prototype.stream = async function* (
    this: PiAiAdapter,
    options: Parameters<PiAiAdapter["stream"]>[0],
  ) {
    wrapProviders(this);
    yield* stream.call(this, options);
  };
  prototype[PATCHED] = true;
}
