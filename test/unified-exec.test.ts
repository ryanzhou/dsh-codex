import { PassThrough } from "node:stream";
import type { Context } from "@deepseek-ai/cordis";
import type { JobHooks, JobOutcome, JobSnapshot } from "@deepseek-ai/dsh-jobs";
import type { ShellProcess } from "@deepseek-ai/dsh-shell";
import type { SubprocessTerminalHandle } from "@deepseek-ai/dsh-subprocess";
import type { ToolDefinition } from "@deepseek-ai/dsh-tools";
import { describe, expect, it, vi } from "vitest";
import { registerUnifiedExec } from "../src/unified-exec.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function runtime(process: ShellProcess, terminal?: SubprocessTerminalHandle) {
  const definitions: ToolDefinition[] = [];
  let hooks!: JobHooks;
  let snapshot = {
    id: "bash-1",
    kind: "bash",
    label: "command",
    status: "running",
    startedAt: Date.now(),
    reported: false,
  } as JobSnapshot;
  const settle = (outcome: JobOutcome) => {
    snapshot = {
      ...snapshot,
      status: outcome.status,
      ...(outcome.detail ? { detail: outcome.detail } : {}),
      finishedAt: Date.now(),
    };
  };
  const jobs = {
    attachController: () => () => undefined,
    start: (spec: { run(): JobHooks }) => {
      hooks = spec.run();
      void hooks.done.then(settle);
      return "bash-1";
    },
    wait: async () => { await Promise.resolve(); return { ...snapshot }; },
    read: () => ({ text: hooks.readOutput?.() ?? "", snapshot: { ...snapshot, reported: snapshot.status !== "running" } }),
    get: () => ({ ...snapshot }),
    kill: (_id: string, _owner: unknown, reason?: string) => {
      hooks.cancel(reason);
      snapshot = { ...snapshot, status: "stopping", reported: true };
      return "requested";
    },
  };
  const sandbox = { confine: vi.fn((argv: readonly string[]) => ({ argv: ["sandbox", ...argv] })) };
  const ctx = {
    jobs,
    shell: {
      resolve: (request: unknown) => request,
      start: () => process,
    },
    shellEnv: { collect: () => ({ DSH_HOME: "/tmp/dsh" }) },
    sandboxPolicy: { resolve: () => ({ mode: "workspace-write", workspaceRoot: "/workspace" }) },
    subprocess: { spawnTerminal: async () => terminal },
    get: (name: string) => name === "sandbox" ? sandbox : undefined,
    tools: { register: (definition: ToolDefinition) => { definitions.push(definition); return () => undefined; } },
  } as unknown as Context;
  registerUnifiedExec(ctx);
  return { definitions, sandbox };
}

const owner = { session: {} };
const execution = {
  agent: owner,
  callId: "call",
  rootCallId: "call",
  token: Symbol("call"),
  signal: new AbortController().signal,
  deferContext: () => undefined,
  concludeTurn: () => undefined,
} as never;

describe("unified exec", () => {
  it("returns completed pipe output with Codex framing and DSH sandbox diagnostics", async () => {
    let read = false;
    const process = {
      status: "completed",
      exitCode: 1,
      signal: null,
      done: Promise.resolve(),
      sandbox: { mode: "workspace-write", denied: true },
      readOutput: () => read
        ? { delta: "", lossy: false }
        : (read = true, { delta: "denied", lossy: true, stdoutSpillPath: "/tmp/full.log" }),
      kill: () => false,
    } as ShellProcess;
    const { definitions } = runtime(process);
    const exec = definitions.find((tool) => tool.name === "exec_command")!;

    const result = await exec.execute({ cmd: "touch /outside", workdir: "src", yield_time_ms: 250 }, execution);

    expect(result).toContain("Process exited with code 1");
    expect(result).toContain("denied");
    expect(result).toContain("full output: /tmp/full.log");
    expect(result).toContain("[sandbox: file access denied under workspace-write mode]");
  });

  it("yields pipe commands and lets write_stdin poll their final output", async () => {
    const done = deferred<void>();
    let output = "starting\n";
    const process = {
      status: "running",
      exitCode: null,
      signal: null,
      done: done.promise,
      readOutput: () => { const delta = output; output = ""; return { delta, lossy: false }; },
      kill: () => false,
    } as ShellProcess;
    void done.promise.then(() => {
      process.status = "completed";
      process.exitCode = 0;
      output = "finished\n";
    });
    const { definitions } = runtime(process);
    const exec = definitions.find((tool) => tool.name === "exec_command")!;
    const write = definitions.find((tool) => tool.name === "write_stdin")!;

    const first = await exec.execute({ cmd: "long-task", yield_time_ms: 250 }, execution) as string;
    const sessionId = Number(first.match(/session ID (\d+)/)?.[1]);
    expect(first).toContain("starting");

    done.resolve();
    await done.promise;
    await Promise.resolve();
    const final = await write.execute({ session_id: sessionId }, execution);
    expect(final).toContain("Process exited with code 0");
    expect(final).toContain("finished");
  });

  it("writes to a sandboxed PTY and retains it as the same exec session", async () => {
    const output = new PassThrough();
    const done = deferred<{ exitCode: number; signal: null }>();
    const write = vi.fn(async () => undefined);
    const terminal = {
      pid: 42,
      output,
      done: done.promise,
      write,
      inspectForeground: async () => undefined,
      signalForeground: async () => 42,
      terminate: async () => undefined,
    } as SubprocessTerminalHandle;
    const unusedProcess = {} as ShellProcess;
    const { definitions, sandbox } = runtime(unusedProcess, terminal);
    const exec = definitions.find((tool) => tool.name === "exec_command")!;
    const stdin = definitions.find((tool) => tool.name === "write_stdin")!;

    const first = await exec.execute({ cmd: "python", tty: true, yield_time_ms: 250 }, execution) as string;
    const sessionId = Number(first.match(/session ID (\d+)/)?.[1]);
    output.write("ready> ");
    const interaction = await stdin.execute({ session_id: sessionId, chars: "print(1)\n" }, execution);

    expect(write).toHaveBeenCalledWith("print(1)\n");
    expect(interaction).toContain("ready>");
    expect(sandbox.confine).toHaveBeenCalledWith(expect.arrayContaining(["-lc", "python"]), expect.objectContaining({ mode: "workspace-write" }));

    output.end("1\n");
    done.resolve({ exitCode: 0, signal: null });
    await done.promise;
  });
});
