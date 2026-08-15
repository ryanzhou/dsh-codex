import { fileURLToPath } from "node:url";
import type { Context } from "@deepseek-ai/cordis";
import type { ContentBlock } from "@deepseek-ai/dsh-llm";
import type { PromptAssembly } from "@deepseek-ai/dsh-system-prompt";
import { defineTool, type FileDiff, type JsonValue, type ToolExecutionResult, type ToolRunContext } from "@deepseek-ai/dsh-tools";
import { parsePatch } from "./apply-patch/index.js";
import { registerUnifiedExec } from "./unified-exec.js";

export const name = "codex-tools";
export const inject = ["tools", "systemPrompt", "jobs", "shell", "shellEnv", "sandboxPolicy", "subprocess"];

const DELEGATE_TOOLS = new Set([
  "bash", "pwsh", "read", "write", "edit",
  "todo_write", "ask_user_question", "read_image", "job_output", "job_list", "job_kill",
]);
const DELEGATE_SECTIONS = new Set([
  "tool:bash", "tool:pwsh", "tool:read", "tool:write", "tool:edit", "tool:jobs",
]);

function hideDelegates(assembly: PromptAssembly): PromptAssembly {
  if (!assembly.tools.some((tool) => tool.name === "apply_patch") ||
      !assembly.tools.some((tool) => tool.name === "exec_command")) return assembly;
  assembly.tools = assembly.tools.filter((tool) => !DELEGATE_TOOLS.has(tool.name));
  assembly.sections = assembly.sections.filter((section) => !DELEGATE_SECTIONS.has(section.name));
  return assembly;
}

const cli = fileURLToPath(new URL("./apply-patch/cli.js", import.meta.url));
const textOutput = {
  schema: { type: "string" as const },
  render: (_args: unknown, value: string) => [{ type: "text" as const, text: value }],
};

function resultText(result: ToolExecutionResult): string {
  return result.content
    .filter((block): block is Extract<ContentBlock, { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

function patchPresentation(patch: string) {
  try {
    const hunks = parsePatch(patch);
    const diffs: FileDiff[] = [];
    const locations = hunks.map((hunk) => ({ path: hunk.kind === "update" && hunk.movePath ? hunk.movePath : hunk.path }));
    for (const hunk of hunks) {
      if (hunk.kind === "add") diffs.push({ path: hunk.path, oldText: null, newText: hunk.content });
      if (hunk.kind === "update") for (const chunk of hunk.chunks) diffs.push({
        path: hunk.movePath ?? hunk.path,
        oldText: chunk.oldLines.join("\n") + (chunk.oldLines.length ? "\n" : ""),
        newText: chunk.newLines.join("\n") + (chunk.newLines.length ? "\n" : ""),
      });
    }
    if (diffs.length) return { card: "diff" as const, title: "Apply patch", diffs, locations };
    return { card: "generic" as const, title: "Apply patch", kind: "edit" as const, locations };
  } catch {
    return { card: "generic" as const, title: "Apply patch", kind: "edit" as const };
  }
}

async function dispatch(
  ctx: Context,
  exec: ToolRunContext,
  name: string,
  args: unknown,
): Promise<ToolExecutionResult & { isError: false }> {
  const result = await ctx.tools.execute({
    callId: (String(exec.callId) + ":codex:" + name) as typeof exec.callId,
    rootCallId: exec.rootCallId,
    name,
    arguments: args,
    ...(exec.agent ? { agent: exec.agent } : {}),
    parent: exec.token,
    signal: exec.signal,
  });
  for (const context of result.additionalContexts ?? []) exec.deferContext(context);
  if (result.isError) throw new Error(resultText(result));
  if (result.concludesTurn) exec.concludeTurn();
  return result;
}

type ShellResult = {
  kind: "foreground";
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  timeoutMs: number;
  stdout: { text: string; truncated: boolean; spillPath?: string };
  stderr: { text: string; truncated: boolean; spillPath?: string };
  sandbox?: { mode: string; denied: boolean };
};

function quote(value: string): string {
  return process.platform === "win32"
    ? "'" + value.replaceAll("'", "''") + "'"
    : "'" + value.replaceAll("'", "'\\''") + "'";
}

function commandForPatch(patch: string): string {
  const command = [process.execPath, cli, Buffer.from(patch).toString("base64url")]
    .map(quote)
    .join(" ");
  return process.platform === "win32" ? "& " + command : command;
}

function sandboxText(result: ShellResult): string {
  return result.sandbox?.denied
    ? "[sandbox: file access denied under " + result.sandbox.mode + " mode]"
    : "";
}

export function apply(ctx: Context): void {
  ctx.on("system-prompt/assemble", async (assembly, _context, next) => hideDelegates(await next()));
  const shell = process.platform === "win32" ? "pwsh" : "bash";

  ctx.tools.register(defineTool({
    name: "apply_patch",
    description: "The `apply_patch` tool can be used to edit files. This is a FREEFORM tool, so do not wrap the patch in JSON.",
    parameters: {
      patch: { type: "string", required: true },
    },
    output: textOutput,
    async execute(args, exec) {
      const result = await dispatch(ctx, exec, shell, {
        command: commandForPatch(args.patch),
        description: "Apply a Codex file patch",
      });
      const value = result.value as unknown as ShellResult;
      if (value.exitCode !== 0) {
        throw new Error([value.stderr.text, value.stdout.text, sandboxText(value)].filter(Boolean).join("\n") || "apply_patch failed");
      }
      return "Patch applied.";
    },
    presentCall: (args) => patchPresentation(args.patch),
    presentResult: (args, result) => {
      const view = patchPresentation(args.patch);
      return !result.isError && view.card === "diff" ? { card: "diff", diffs: view.diffs } : undefined;
    },
  }));

  registerUnifiedExec(ctx);

  ctx.tools.register(defineTool({
    name: "update_plan",
    description: "Updates the task plan.\nProvide an optional explanation and a list of plan items, each with a step and status.\nAt most one step can be in_progress at a time.\n",
    parameters: {
      explanation: { type: "string", description: "Optional explanation for this plan update." },
      plan: {
        type: "array",
        required: true,
        description: "The list of steps",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            step: { type: "string", required: true, description: "Task step text." },
            status: { type: "string", required: true, description: "Step status.", enum: ["pending", "in_progress", "completed"] },
          },
        },
      },
    },
    output: textOutput,
    async execute(args, exec) {
      if (args.plan.filter((step) => step.status === "in_progress").length > 1) {
        throw new Error("at most one plan step may be in_progress");
      }
      await dispatch(ctx, exec, "todo_write", {
        todos: args.plan.map((step) => ({ content: step.step, status: step.status })),
      });
      return "Plan updated";
    },
    presentCall: (args) => ({
      card: "generic",
      title: "Update todo list",
      kind: "other",
      rawInput: args.plan.map((step) => ({ content: step.step, status: step.status })),
    }),
  }));

  ctx.tools.register(defineTool({
    name: "request_user_input",
    description: "Request user input for one to three short questions and wait for the response. This tool is only available in Default mode.",
    parameters: {
      questions: {
        type: "array",
        required: true,
        description: "Questions to show the user. Prefer 1 and do not exceed 3",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            id: { type: "string", required: true, description: "Stable identifier for mapping answers (snake_case)." },
            header: { type: "string", required: true, description: "Short header label shown in the UI (12 or fewer chars)." },
            question: { type: "string", required: true, description: "Single-sentence prompt shown to the user." },
            options: {
              type: "array",
              required: true,
              description: "Provide 2-3 mutually exclusive choices. Put the recommended option first and suffix its label with \"(Recommended)\". Do not include an \"Other\" option in this list; the client will add a free-form \"Other\" option automatically.",
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  label: { type: "string", required: true, description: "User-facing label (1-5 words)." },
                  description: { type: "string", required: true, description: "One short sentence explaining impact/tradeoff if selected." },
                },
              },
            },
          },
        },
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          answers: { type: "object", required: true, additionalProperties: true },
        },
      },
      render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      if (args.questions.length < 1 || args.questions.length > 3) throw new Error("request_user_input requires one to three questions");
      if (args.questions.some((question) => question.header.length > 12)) throw new Error("request_user_input headers must be 12 characters or fewer");
      if (args.questions.some((question) => question.options.length === 0)) throw new Error("request_user_input requires non-empty options for every question");
      const result = await dispatch(ctx, exec, "ask_user_question", { questions: args.questions });
      const value = result.value as { answers: Array<{ id: string; selected: string[]; custom?: string }> };
      return { answers: Object.fromEntries(value.answers.map((answer) => [
        answer.id,
        { answers: [...answer.selected, ...(answer.custom ? [answer.custom] : [])] },
      ])) };
    },
    presentCall: (args) => ({ card: "generic", title: "Ask user", kind: "other", rawInput: args.questions }),
  }));

  ctx.tools.register(defineTool({
      name: "view_image",
      description: "View a local image file from the filesystem when visual inspection is needed. Use this for images already available on disk.",
      parameters: {
        path: { type: "string", required: true, description: "Local filesystem path to an image file." },
        detail: { type: "string", enum: ["high", "original"], description: "Image detail level. Defaults to `high`; use `original` to preserve exact resolution." },
      },
      output: {
        schema: { type: "array", items: { type: "object", additionalProperties: true, properties: { type: { type: "string", required: true } } } },
        render: (_args, value) => value as unknown as ContentBlock[],
      },
      async execute(args, exec) {
        const result = await dispatch(ctx, exec, "read_image", { file_path: args.path });
        return result.content as unknown as Array<{ type: string } & Record<string, JsonValue>>;
      },
      isConcurrencySafe: () => true,
      presentCall: (args) => ({
        card: "generic",
        title: "Read image " + args.path,
        kind: "read",
        locations: [{ path: args.path }],
      }),
  }));
}
