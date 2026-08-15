import { describe, expect, it } from "vitest";
import type { Context } from "@deepseek-ai/cordis";
import type { ToolDefinition } from "@deepseek-ai/dsh-tools";
import { apply } from "../src/tools.js";

describe("Codex tool catalog", () => {
  it("exposes only the pinned native surface and keeps DSH delegates internal", () => {
    const definitions: ToolDefinition[] = [];
    const ctx = {
      on: () => () => undefined,
      jobs: { attachController: () => () => undefined },
      tools: {
        register: (definition: ToolDefinition) => { definitions.push(definition); return () => undefined; },
      },
    } as unknown as Context;

    apply(ctx);

    expect(definitions.map((tool) => tool.name)).toEqual([
      "apply_patch",
      "exec_command",
      "write_stdin",
      "update_plan",
      "request_user_input",
      "view_image",
    ]);
    expect(definitions[0]?.parameters).toEqual({
      type: "object",
      properties: { patch: { type: "string" } },
      required: ["patch"],
    });
    expect(Object.keys(definitions[1]?.parameters.properties ?? {})).toEqual([
      "cmd", "workdir", "tty", "yield_time_ms", "max_output_tokens", "justification", "sandbox_permissions",
    ]);

    expect(definitions[0]?.presentCall?.({ patch: [
      "*** Begin Patch",
      "*** Add File: notes.txt",
      "+hello",
      "*** End Patch",
    ].join("\n") })).toMatchObject({
      card: "diff",
      diffs: [{ path: "notes.txt", oldText: null, newText: "hello\n" }],
    });
    expect(definitions[1]?.presentCall?.({ cmd: "pwd", workdir: "/work" })).toEqual({
      card: "terminal",
      title: "pwd",
      cwd: "/work",
    });
    expect(definitions[3]?.presentCall?.({ plan: [{ step: "Review", status: "in_progress" }] })).toMatchObject({
      title: "Update todo list",
      rawInput: [{ content: "Review", status: "in_progress" }],
    });
    expect(definitions[4]?.presentCall?.({ questions: [] })).toMatchObject({ title: "Ask user" });
    expect(definitions[5]?.presentCall?.({ path: "diagram.png" })).toMatchObject({
      title: "Read image diagram.png",
      locations: [{ path: "diagram.png" }],
    });
  });

  it("removes delegate schemas and guidance from the model assembly", async () => {
    let listener: (...args: never[]) => Promise<unknown> = async () => undefined;
    apply({
      on: (_event: string, value: typeof listener) => { listener = value; return () => undefined; },
      jobs: { attachController: () => () => undefined },
      tools: { register: () => () => undefined },
    } as unknown as Context);
    const assembly = {
      sections: [
        { name: "deployment:persona", text: "Codex" },
        { name: "tool:bash", text: "Use bash" },
        { name: "tool:read", text: "Use read" },
      ],
      contexts: [],
      tools: [
        { name: "bash" },
        { name: "job_output" },
        { name: "read" },
        { name: "apply_patch" },
        { name: "exec_command" },
        { name: "write_stdin" },
      ],
      variables: {},
    };
    expect(await listener(assembly as never, {} as never, (async () => assembly) as never)).toEqual({
      sections: [{ name: "deployment:persona", text: "Codex" }],
      contexts: [],
      tools: [{ name: "apply_patch" }, { name: "exec_command" }, { name: "write_stdin" }],
      variables: {},
    });
  });

  it("returns Codex's question-id answer map", async () => {
    const definitions: ToolDefinition[] = [];
    apply({
      on: () => () => undefined,
      jobs: { attachController: () => () => undefined },
      tools: {
        register: (definition: ToolDefinition) => { definitions.push(definition); return () => undefined; },
        execute: async () => ({
          isError: false,
          value: { answers: [{ id: "mode", selected: ["Fast"], custom: "with checks" }] },
          content: [],
          additionalContexts: [],
          concludesTurn: false,
        }),
      },
    } as unknown as Context);
    const request = definitions.find((tool) => tool.name === "request_user_input")!;
    const exec = {
      callId: "outer",
      rootCallId: "outer",
      token: Symbol("outer"),
      signal: new AbortController().signal,
      deferContext: () => undefined,
      concludeTurn: () => undefined,
    } as never;
    const value = await request.execute({ questions: [{
      id: "mode",
      header: "Mode",
      question: "Which mode?",
      options: [{ label: "Fast", description: "Run quickly." }],
    }] }, exec);
    expect(value).toEqual({ answers: { mode: { answers: ["Fast", "with checks"] } } });
    await expect(request.execute({ questions: [] }, exec)).rejects.toThrow("one to three questions");
  });

});
