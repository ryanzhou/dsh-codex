import { describe, expect, it } from "vitest";
import { convertResponsesTools } from "@earendil-works/pi-ai/api/openai-responses-shared";
import { addCodexGrammar } from "../src/pi-ai.js";

const parameters = {
  type: "object",
  properties: { patch: { type: "string" } },
  required: ["patch"],
};

describe("pi-ai bridge", () => {
  it("leaves non-Codex tool contexts untouched", () => {
    const context = { tools: [{ name: "bash", description: "", parameters }] };
    expect(addCodexGrammar(context)).toBe(context);
  });

  it("emits apply_patch as an OpenAI custom grammar tool", () => {
    const context = addCodexGrammar({ tools: [
      { name: "apply_patch", description: "Apply", parameters },
      { name: "exec_command", description: "Shell", parameters },
    ] });
    const wire = convertResponsesTools(context.tools as never, { supportsOpenAIGrammarTools: true });
    expect(wire.map((tool) => ({ type: tool.type, name: "name" in tool ? tool.name : undefined }))).toEqual([
      { type: "custom", name: "apply_patch" },
      { type: "function", name: "exec_command" },
    ]);
    expect(wire[0]).toMatchObject({ format: { type: "grammar", syntax: "lark" } });
  });

});
