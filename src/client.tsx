import { useMemo, useState } from "react";
import type { ComponentType } from "react";
import type { ClientContext, JobView } from "@deepseek-ai/dsh-client-runtime/client";
import { StateDot } from "@deepseek-ai/dsh-client-ui-primitives";
import type { PropsRuntime, TranslateNS } from "@deepseek-ai/dsh-client-ui-slots";
import type {} from "@deepseek-ai/dsh-client-ui-conversation/client";
import type {} from "@deepseek-ai/dsh-client-ui-tool/client";
import { isLive, visibleJobs } from "./client-model.js";

type ToolProps = PropsRuntime<"tool.call.toolview">;
type NativeBashProps = ToolProps & { t: TranslateNS<"conversation"> };
type JobProps = PropsRuntime<"conversation.session.header.actions">;

const noJobs: readonly JobView[] = [];

const rootStyle = { position: "relative" as const };
const triggerStyle = { display: "flex", alignItems: "center", gap: 6, minHeight: 28, padding: "3px 2px", border: 0, background: "transparent", color: "var(--dsw-alias-label-tertiary)", fontSize: 12, cursor: "pointer" };
const menuStyle = { position: "absolute" as const, top: "calc(100% + 5px)", left: 0, zIndex: 100, width: 336, maxHeight: 420, margin: 0, padding: 4, overflow: "auto", listStyle: "none", border: "1px solid var(--dsw-alias-border-l2)", borderRadius: 12, background: "var(--dsw-specific-menu)", boxShadow: "var(--dsw-shadow-lv3)" };
const rowStyle = { display: "grid", gridTemplateColumns: "12px minmax(80px, 1fr) auto", alignItems: "center", gap: 8, minHeight: 32, padding: "6px 8px", color: "var(--dsw-alias-label-primary)", fontSize: 13 };

function BackgroundTerminals({ sessionId, useSessions }: JobProps) {
  const [open, setOpen] = useState(false);
  const allJobs = useSessions((snapshot) => snapshot.jobsBySession[sessionId]) ?? noJobs;
  const codex = useSessions((snapshot) => snapshot.byId[sessionId]?.agentPreset === "codex");
  const jobs = useMemo(() => visibleJobs(allJobs, codex), [allJobs, codex]);
  if (jobs.length === 0) return null;
  const live = jobs.filter(isLive).length;
  const label = live > 0
    ? `${live} background terminal${live === 1 ? "" : "s"} running`
    : `${jobs.length} background job${jobs.length === 1 ? "" : "s"}`;
  return <div style={rootStyle}>
    <button type="button" style={triggerStyle} aria-label={label} aria-expanded={open} onClick={() => setOpen(!open)}>
      {live > 0 ? <StateDot state="ongoing" /> : null}
      <span>{label}</span>
    </button>
    {open ? <ul style={menuStyle} aria-label="Background terminals">
      {jobs.map((job) => <li key={job.id} style={rowStyle}>
        <StateDot state={isLive(job) ? "ongoing" : job.status === "failed" ? "error" : "done"} />
        <span title={job.label}>{job.label}</span>
        <span>{job.detail ?? job.status}</span>
      </li>)}
    </ul> : null}
  </div>;
}

export const inject = ["slots"];

export function apply(ctx: ClientContext): void {
  const NativeBash = ctx.slots.entries("tool.call.toolview").find((entry) => entry.options.key === "bash")!.component as ComponentType<NativeBashProps>;
  const BashRow = (props: NativeBashProps) => <NativeBash {...props} toolName="bash" />;
  ctx.slots.inject("tool.call.toolview", function* () {
    yield ctx.slots.register({ name: "tool.call.toolview", key: "exec_command", priority: -10, locale: "conversation" }, BashRow);
    yield ctx.slots.register({ name: "tool.call.toolview", key: "write_stdin", priority: -10, locale: "conversation" }, BashRow);
  });
  ctx.slots.inject("conversation.session.header.actions", () => ctx.slots.register({
    name: "conversation.session.header.actions",
    id: "job-list",
    priority: -10,
    order: 20,
  }, BackgroundTerminals));
}
