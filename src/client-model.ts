import type { JobView } from "@deepseek-ai/dsh-client-runtime/client";

export const isLive = (job: JobView): boolean => job.status === "running" || job.status === "stopping";

export function visibleJobs(jobs: readonly JobView[], codex: boolean): readonly JobView[] {
  return codex ? jobs.filter(isLive) : jobs;
}
