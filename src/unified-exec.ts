import { randomBytes } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import { finished } from "node:stream/promises";
import { StringDecoder } from "node:string_decoder";
import type { Context } from "@deepseek-ai/cordis";
import type { JobId, JobSnapshot } from "@deepseek-ai/dsh-jobs";
import { approveEscalation, sandboxDenialMarker, validateEscalationArgs, type SandboxExecutionPolicy } from "@deepseek-ai/dsh-sandbox";
import type { ShellProcess } from "@deepseek-ai/dsh-shell";
import type {} from "@deepseek-ai/dsh-shell-env";
import type {} from "@deepseek-ai/dsh-sandbox-policy";
import type { SubprocessTerminalHandle } from "@deepseek-ai/dsh-subprocess";
import { defineTool, type ToolRunContext } from "@deepseek-ai/dsh-tools";

const MAX_PTY_OUTPUT = 1024 * 1024;
const MAX_NOTICE_WAIT = 2_147_483_647;
const MAX_SESSIONS = 64;

type ExecArgs = {
  cmd: string;
  workdir?: string;
  tty?: boolean;
  yield_time_ms?: number;
  max_output_tokens?: number;
  justification?: string;
  sandbox_permissions?: "use_default" | "require_escalated";
};

type WriteArgs = {
  session_id: number;
  chars?: string;
  yield_time_ms?: number;
  max_output_tokens?: number;
};

type ExecSession = {
  jobId: JobId;
  terminal?: Promise<SubprocessTerminalHandle>;
  pending: Promise<void>;
};

const textOutput = {
  schema: { type: "string" as const },
  render: (_args: unknown, value: string) => [{ type: "text" as const, text: value }],
};

function positive(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value <= 0) throw new Error(`expected a positive number, got ${value}`);
  return Math.max(minimum, Math.min(maximum, Math.trunc(value)));
}

function outputBudget(value: number | undefined): number {
  return positive(value, 10_000, 1, 262_144);
}

function truncateOutput(output: string, tokens: number): { text: string; originalTokens?: number } {
  const maxChars = tokens * 4;
  if (output.length <= maxChars) return { text: output };
  const half = Math.max(1, Math.floor((maxChars - 80) / 2));
  return {
    text: `${output.slice(0, half)}\n[... output truncated ...]\n${output.slice(-half)}`,
    originalTokens: Math.ceil(output.length / 4),
  };
}

function formatResult(snapshot: JobSnapshot, output: string, wallMs: number, maxTokens: number, sessionId?: number): string {
  const truncated = truncateOutput(output, maxTokens);
  const lines = [
    `Chunk ID: ${randomBytes(3).toString("hex")}`,
    `Wall time: ${(wallMs / 1000).toFixed(4)} seconds`,
  ];
  const exitCode = snapshot.detail?.match(/^exit code: (-?\d+)$/)?.[1];
  if (exitCode !== undefined) lines.push(`Process exited with code ${exitCode}`);
  else if (snapshot.detail?.startsWith("signal:")) lines.push(`Process exited with ${snapshot.detail}`);
  else if (snapshot.status === "failed") lines.push(`Process failed: ${snapshot.detail ?? "unknown error"}`);
  if (sessionId !== undefined && (snapshot.status === "running" || snapshot.status === "stopping")) {
    lines.push(`Process running with session ID ${sessionId}`);
  }
  if (truncated.originalTokens !== undefined) lines.push(`Original token count: ${truncated.originalTokens}`);
  lines.push("Output:", truncated.text);
  return lines.join("\n");
}

function shellOutput(process: ShellProcess): string {
  const read = process.readOutput();
  const notices: string[] = [];
  if (read.lossy) {
    const paths = [read.stdoutSpillPath, read.stderrSpillPath].filter((path): path is string => path !== undefined);
    notices.push(`[some output was dropped from memory; full output: ${paths.join(", ") || "unavailable"}]`);
  }
  if (process.sandbox?.denied) notices.push(sandboxDenialMarker(process.sandbox.mode));
  return [read.delta, ...notices].filter(Boolean).join("\n");
}

function startShellJob(ctx: Context, args: ExecArgs, exec: ToolRunContext, policy: SandboxExecutionPolicy): JobId {
  if (!exec.agent) throw new Error("exec_command requires an owning agent");
  return ctx.jobs.start({
    kind: "bash",
    label: args.cmd,
    owner: exec.agent,
    run: () => {
      const process = ctx.shell.start(ctx.shell.resolve({
        command: args.cmd,
        workdir: workdir(args.workdir, policy.workspaceRoot),
        dshEnv: ctx.shellEnv.collect(exec),
        sandboxPolicy: policy,
      }));
      return {
        cancel: () => void process.kill(),
        done: process.done.then(() => ({
          status: process.status === "killed" ? "killed" as const : "completed" as const,
          detail: process.signal ? `signal: ${process.signal}` : `exit code: ${process.exitCode ?? 0}`,
        })),
        readOutput: () => shellOutput(process),
      };
    },
  });
}

function boundedPtyOutput() {
  let output = "";
  let dropped = false;
  const decoder = new StringDecoder("utf8");
  return {
    append(chunk: Buffer) {
      output += decoder.write(chunk);
      if (output.length > MAX_PTY_OUTPUT) {
        output = output.slice(-MAX_PTY_OUTPUT);
        dropped = true;
      }
    },
    end() { output += decoder.end(); },
    read() {
      const value = `${dropped ? "[some terminal output was dropped from memory]\n" : ""}${output}`;
      output = "";
      dropped = false;
      return value;
    },
  };
}

function commandArgv(command: string): string[] {
  if (process.platform === "win32") return ["pwsh", "-NoLogo", "-NoProfile", "-Command", command];
  return [process.env.SHELL || "bash", "-lc", command];
}

function startTerminalJob(
  ctx: Context,
  args: ExecArgs,
  exec: ToolRunContext,
  policy: SandboxExecutionPolicy,
): { jobId: JobId; terminal: Promise<SubprocessTerminalHandle> } {
  if (!exec.agent) throw new Error("exec_command requires an owning agent");
  let terminal!: Promise<SubprocessTerminalHandle>;
  const jobId = ctx.jobs.start({
    kind: "bash",
    label: args.cmd,
    owner: exec.agent,
    run: () => {
      const buffer = boundedPtyOutput();
      let cancelled = false;
      let argv = commandArgv(args.cmd);
      if (policy.mode !== "danger-full-access") {
        const sandbox = ctx.get("sandbox");
        if (!sandbox) throw new Error(`sandbox mode "${policy.mode}" requires a sandbox provider`);
        argv = sandbox.confine(argv, { ...policy, mode: policy.mode }).argv;
      }
      terminal = ctx.subprocess.spawnTerminal({
        argv,
        cwd: workdir(args.workdir, policy.workspaceRoot),
        env: { ...ctx.shellEnv.collect(exec), TERM: "xterm-256color" },
        rows: 40,
        cols: 160,
        graceMs: 3000,
      }).then((handle) => {
        handle.output.on("data", (chunk: Buffer) => buffer.append(chunk));
        handle.output.once("end", () => buffer.end());
        if (cancelled) void handle.terminate();
        return handle;
      });
      return {
        cancel: () => {
          cancelled = true;
          void terminal.then((handle) => handle.terminate()).catch(() => undefined);
        },
        done: terminal.then(async (handle) => {
          try {
            const [outcome] = await Promise.all([handle.done, finished(handle.output)]);
            return {
              status: cancelled || outcome.signal ? "killed" as const : "completed" as const,
              detail: outcome.signal ? `signal: ${outcome.signal}` : `exit code: ${outcome.exitCode ?? 0}`,
            };
          } catch (error) {
            return { status: "failed" as const, detail: String(error) };
          }
        }),
        readOutput: () => buffer.read(),
      };
    },
  });
  return { jobId, terminal };
}

function workdir(value: string | undefined, base: string): string {
  return value === undefined ? base : isAbsolute(value) ? value : resolve(base, value);
}

async function policyFor(ctx: Context, args: ExecArgs, exec: ToolRunContext): Promise<SandboxExecutionPolicy> {
  const standing = ctx.sandboxPolicy.resolve(exec.agent ? { session: exec.agent.session } : undefined);
  const requested = args.sandbox_permissions === "require_escalated" ? "danger-full-access" : undefined;
  const justification = args.justification?.trim() ? args.justification : undefined;
  validateEscalationArgs(requested, justification);
  if (requested === undefined || justification === undefined) return standing;
  const mode = await approveEscalation({
    requestedMode: requested,
    justification,
    effectiveMode: standing.mode,
    subject: "command",
  }, {
    approver: ctx.get("approval"),
    agent: exec.agent,
    callId: exec.callId,
    toolName: "exec_command",
    signal: exec.signal,
  });
  return { ...standing, mode };
}

async function collect(
  ctx: Context,
  sessions: Map<number, ExecSession>,
  session: ExecSession,
  owner: NonNullable<ToolRunContext["agent"]>,
  waitMs: number,
  maxTokens: number,
  signal: AbortSignal,
  started: number,
  sessionId?: number,
): Promise<string> {
  await ctx.jobs.wait(session.jobId, waitMs, owner, signal);
  const read = ctx.jobs.read(session.jobId, owner);
  const running = read.snapshot.status === "running" || read.snapshot.status === "stopping";
  if (!running && sessionId !== undefined) sessions.delete(sessionId);
  return formatResult(read.snapshot, read.text, Date.now() - started, maxTokens, running ? sessionId : undefined);
}

async function exclusive<T>(session: ExecSession, operation: () => Promise<T>): Promise<T> {
  const previous = session.pending;
  let release!: () => void;
  session.pending = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  try {
    return await operation();
  } finally {
    release();
  }
}

export function registerUnifiedExec(ctx: Context): void {
  const sessions = new Map<number, ExecSession>();
  let nextSessionId = 1;
  ctx.jobs.attachController("codex-unified-exec");

  ctx.tools.register(defineTool({
    name: "exec_command",
    description: "Runs a shell command, yielding a session ID when it remains active. Set tty for an interactive PTY-backed process.",
    parameters: {
      cmd: { type: "string", required: true, description: "Shell command to execute." },
      workdir: { type: "string", description: "Working directory for the command. Defaults to the turn cwd." },
      tty: { type: "boolean", description: "True allocates a PTY; false or omitted uses plain pipes." },
      yield_time_ms: { type: "number", description: "Wait before yielding output. Defaults to 10000 ms; effective range is 250-30000 ms." },
      max_output_tokens: { type: "number", description: "Output token budget. Defaults to 10000 tokens." },
      justification: { type: "string", description: "User-facing approval question for require_escalated; omit otherwise." },
      sandbox_permissions: {
        type: "string",
        enum: ["use_default", "require_escalated"],
        description: "Per-command sandbox override. Defaults to use_default.",
      },
    },
    output: textOutput,
    async execute(rawArgs, exec) {
      const args = rawArgs as ExecArgs;
      if (!args.cmd.trim()) throw new Error("cmd must be a non-empty string");
      if (!exec.agent) throw new Error("exec_command requires an owning agent");
      const started = Date.now();
      const policy = await policyFor(ctx, args, exec);
      const launched = args.tty
        ? startTerminalJob(ctx, args, exec, policy)
        : { jobId: startShellJob(ctx, args, exec, policy) };
      const session: ExecSession = { ...launched, pending: Promise.resolve() };
      const waitMs = positive(args.yield_time_ms, 10_000, 250, 30_000);
      const snapshot = await ctx.jobs.wait(session.jobId, waitMs, exec.agent, exec.signal);
      if (snapshot.status !== "running" && snapshot.status !== "stopping") {
        const read = ctx.jobs.read(session.jobId, exec.agent);
        return formatResult(read.snapshot, read.text, Date.now() - started, outputBudget(args.max_output_tokens));
      }
      if (sessions.size >= MAX_SESSIONS) {
        ctx.jobs.kill(session.jobId, exec.agent, "unified exec session limit reached");
        throw new Error(`unified exec session limit reached (${MAX_SESSIONS})`);
      }
      const sessionId = nextSessionId++;
      sessions.set(sessionId, session);
      void ctx.jobs.wait(session.jobId, MAX_NOTICE_WAIT, exec.agent).catch(() => undefined);
      const read = ctx.jobs.read(session.jobId, exec.agent);
      return formatResult(read.snapshot, read.text, Date.now() - started, outputBudget(args.max_output_tokens), sessionId);
    },
    presentCall: (args) => ({ card: "terminal", title: args.cmd, ...(args.workdir ? { cwd: args.workdir } : {}) }),
    presentResult: (_args, result) => {
      const text = result.content.find((block) => block.type === "text")?.text ?? "";
      const exitCode = text.match(/Process exited with code (-?\d+)/)?.[1];
      return { card: "terminal", output: text.split("\nOutput:\n")[1] ?? "", ...(exitCode ? { exitCode: Number(exitCode) } : {}) };
    },
  }));

  ctx.tools.register(defineTool({
    name: "write_stdin",
    description: "Writes characters to an existing unified exec session and returns recent output. Omit chars to poll.",
    parameters: {
      session_id: { type: "number", required: true, description: "Identifier of the running unified exec session." },
      chars: { type: "string", description: "Characters to write. Defaults to empty, which polls without writing." },
      yield_time_ms: { type: "number", description: "Wait before yielding output. Empty polls default to 5000 ms." },
      max_output_tokens: { type: "number", description: "Output token budget. Defaults to 10000 tokens." },
    },
    output: textOutput,
    async execute(rawArgs, exec) {
      const args = rawArgs as WriteArgs;
      if (!Number.isSafeInteger(args.session_id)) throw new Error("session_id must be an integer");
      if (!exec.agent) throw new Error("write_stdin requires an owning agent");
      const owner = exec.agent;
      const session = sessions.get(args.session_id);
      if (!session) throw new Error(`unknown exec session ${args.session_id}`);
      ctx.jobs.get(session.jobId, owner);
      return exclusive(session, async () => {
        const started = Date.now();
        const chars = args.chars ?? "";
        if (chars.length > 0) {
          if (session.terminal) {
            try {
              await (await session.terminal).write(chars);
            } catch (error) {
              const status = ctx.jobs.get(session.jobId, owner).status;
              if (status === "running" || status === "stopping") throw error;
            }
          }
          else if (chars === "\u0003") ctx.jobs.kill(session.jobId, owner, "SIGINT");
          else throw new Error(`stdin is closed for exec session ${args.session_id}; start it with tty: true`);
        }
        const waitMs = chars.length === 0
          ? positive(args.yield_time_ms, 5000, 5000, 300_000)
          : positive(args.yield_time_ms, 250, 250, 30_000);
        return collect(ctx, sessions, session, owner, waitMs, outputBudget(args.max_output_tokens), exec.signal, started, args.session_id);
      });
    },
    presentCall: (args) => ({ card: "terminal", title: `Session ${args.session_id} input` }),
  }));
}
