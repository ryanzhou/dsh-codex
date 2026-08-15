import { describe, expect, it, vi } from "vitest";
import type { ClientContext, JobView } from "@deepseek-ai/dsh-client-runtime/client";
import { apply } from "../src/client.js";
import { visibleJobs } from "../src/client-model.js";

vi.mock("@deepseek-ai/dsh-client-ui-primitives", () => ({ StateDot: () => null }));

const job = (status: JobView["status"]): JobView => ({
  id: "bash-1" as JobView["id"],
  kind: "bash",
  label: "test",
  status,
  startedAt: 1,
});

describe("Codex client presentation", () => {
  it("waits for the native Bash row before registering unified exec views", () => {
    const entries: Array<{ options: { key?: string }; component: unknown }> = [];
    const registrations: Array<{ options: { key?: string }; component: unknown }> = [];
    const listeners = new Set<() => void>();
    const slots = {
      entries: () => entries,
      inject: (_key: string, callback: () => unknown) => {
        callback();
        return () => {};
      },
      register: (options: { key?: string }, component: unknown) => {
        registrations.push({ options, component });
        return () => {};
      },
      subscribe: (_key: string, listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };

    expect(() => apply({ slots } as unknown as ClientContext)).not.toThrow();
    expect(registrations.some(({ options }) => options.key === "exec_command")).toBe(false);

    entries.push({ options: { key: "bash" }, component: () => null });
    listeners.forEach((listener) => listener());

    const unifiedExec = registrations.filter(({ options }) => options.key === "exec_command" || options.key === "write_stdin");
    expect(unifiedExec.map(({ options }) => options.key)).toEqual(["exec_command", "write_stdin"]);
    expect(unifiedExec[0]?.component).toBe(unifiedExec[1]?.component);
  });

  it("shows only live jobs as Codex background terminals without changing other presets", () => {
    const jobs = [job("running"), job("completed")];
    expect(visibleJobs(jobs, true)).toEqual([jobs[0]]);
    expect(visibleJobs(jobs, false)).toEqual(jobs);
  });
});
