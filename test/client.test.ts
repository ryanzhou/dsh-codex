import { describe, expect, it } from "vitest";
import type { JobView } from "@deepseek-ai/dsh-client-runtime/client";
import { visibleJobs } from "../src/client-model.js";

const job = (status: JobView["status"]): JobView => ({
  id: "bash-1" as JobView["id"],
  kind: "bash",
  label: "test",
  status,
  startedAt: 1,
});

describe("Codex client presentation", () => {
  it("shows only live jobs as Codex background terminals without changing other presets", () => {
    const jobs = [job("running"), job("completed")];
    expect(visibleJobs(jobs, true)).toEqual([jobs[0]]);
    expect(visibleJobs(jobs, false)).toEqual(jobs);
  });
});
