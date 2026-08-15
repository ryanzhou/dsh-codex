import { describe, expect, it } from "vitest";
import type { Context } from "@deepseek-ai/cordis";
import type { ToolDefinition } from "@deepseek-ai/dsh-tools";
import { apply } from "../src/tools.js";

describe("Codex tool catalog", () => {
  it("exposes only the pinned native surface and keeps DSH delegates internal", () => {
    const definitions: ToolDefinition[] = [];
    const ctx = {
      on: () => () => undefined,
      tools: {
        register: (definition: ToolDefinition) => { definitions.push(definition); return () => undefined; },
      },
    } as unknown as Context;

    apply(ctx);

    expect(definitions.map((tool) => tool.name)).toEqual([
      "apply_patch",
      "shell_command",
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
      "command", "justification", "sandbox_permissions", "timeout_ms", "workdir",
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
    expect(definitions[1]?.presentCall?.({ command: "pwd", workdir: "/work" })).toEqual({
      card: "terminal",
      title: "pwd",
      cwd: "/work",
    });
    expect(definitions[2]?.presentCall?.({ plan: [{ step: "Review", status: "in_progress" }] })).toMatchObject({
      title: "Update todo list",
      rawInput: [{ content: "Review", status: "in_progress" }],
    });
    expect(definitions[3]?.presentCall?.({ questions: [] })).toMatchObject({ title: "Ask user" });
    expect(definitions[4]?.presentCall?.({ path: "diagram.png" })).toMatchObject({
      title: "Read image diagram.png",
      locations: [{ path: "diagram.png" }],
    });
  });

  it("removes delegate schemas and guidance from the model assembly", async () => {
    let listener: (...args: never[]) => Promise<unknown> = async () => undefined;
    apply({
      on: (_event: string, value: typeof listener) => { listener = value; return () => undefined; },
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
        { name: "read" },
        { name: "apply_patch" },
        { name: "shell_command" },
      ],
      variables: {},
    };
    expect(await listener(assembly as never, {} as never, (async () => assembly) as never)).toEqual({
      sections: [{ name: "deployment:persona", text: "Codex" }],
      contexts: [],
      tools: [{ name: "apply_patch" }, { name: "shell_command" }],
      variables: {},
    });
  });

  it("returns Codex's question-id answer map", async () => {
    const definitions: ToolDefinition[] = [];
    apply({
      on: () => () => undefined,
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

  it("preserves DSH sandbox and truncation metadata in shell_command output", async () => {
    const definitions: ToolDefinition[] = [];
    const ctx = {
      on: () => () => undefined,
      tools: {
        register: (definition: ToolDefinition) => { definitions.push(definition); return () => undefined; },
        execute: async () => ({
          isError: false,
          value: {
            kind: "foreground",
            exitCode: 1,
            signal: null,
            timedOut: false,
            timeoutMs: 10000,
            stdout: { text: "retained tail", truncated: true, spillPath: "/tmp/full-output.log" },
            stderr: { text: "denied", truncated: false },
            sandbox: { mode: "workspace-write", denied: true },
          },
          content: [],
          additionalContexts: [],
          concludesTurn: false,
        }),
      },
    } as unknown as Context;
    apply(ctx);
    const shell = definitions.find((tool) => tool.name === "shell_command")!;
    const value = await shell.execute({ command: "touch /outside" }, {
      callId: "outer",
      rootCallId: "outer",
      token: Symbol("outer"),
      signal: new AbortController().signal,
      deferContext: () => undefined,
      concludeTurn: () => undefined,
    } as never);
    expect(value).toContain("[sandbox: file access denied under workspace-write mode]");
    expect(value).toContain("[stdout truncated; full output: /tmp/full-output.log]");
    expect(value).not.toContain("Total output lines: 1");
    expect(shell.presentResult?.({ command: "touch /outside" }, {
      content: [{ type: "text", text: value as string }],
      isError: false,
    })).toEqual({
      card: "terminal",
      output: "retained tail\n[stdout truncated; full output: /tmp/full-output.log]\ndenied\n[sandbox: file access denied under workspace-write mode]",
      exitCode: 1,
    });
  });
});
