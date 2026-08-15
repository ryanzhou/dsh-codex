import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { installPresetRoot } from "../src/presets.js";

describe("preset root bridge", () => {
  it("places the packaged preset before the user root and removes it on disposal", () => {
    const shipped = { path: "/shipped", trust: "system" as const };
    const user = { path: "/user", trust: "user" as const };
    const presetService = {
      config: { includeUserRoot: true },
      resolvedRoots: [shipped, user],
    };
    const dispose = installPresetRoot(presetService as never);
    expect(presetService.resolvedRoots.map((root) => root.path)).toEqual([
      "/shipped",
      expect.stringMatching(/agent-presets$/),
      "/user",
    ]);
    expect(presetService.resolvedRoots[1]?.trust).toBe("system");
    dispose();
    expect(presetService.resolvedRoots).toEqual([shipped, user]);
  });

  it("describes the preset as a Codex-style behavior mode", async () => {
    const metadata = await readFile(new URL("../agent-presets/codex/preset.yml", import.meta.url), "utf8");
    expect(metadata).toContain("name: Codex-style mode\n");
    expect(metadata).toContain("description: Makes DSH behave like Codex for models post-trained on Codex agent behavior");
  });

  it("mounts DSH's automatic and manual compaction services", async () => {
    const composition = await readFile(new URL("../agent-presets/codex/agent.cordis.yml", import.meta.url), "utf8");
    expect(composition).toContain("    compaction: true\n    toolResultPruner: true\n");
    expect(composition).toContain("name: '@deepseek-ai/dsh-compaction-basic'");
    expect(composition).toContain("name: '@deepseek-ai/dsh-command-compact'");
    expect(composition).toContain("name: '@deepseek-ai/dsh-compaction-tool-result-pruner'");
  });

  it("composes native goal and plan lifecycles with Codex plan guidance", async () => {
    const composition = await readFile(new URL("../agent-presets/codex/agent.cordis.yml", import.meta.url), "utf8");
    expect(composition).toContain("name: '@deepseek-ai/dsh-tool-goal'");
    expect(composition).toContain("name: '@deepseek-ai/dsh-plan-mode'");
    expect(composition).toContain("isolate:\n    planMode: true");
    expect(composition).toContain("# Plan Mode (Conversational)");
    expect(composition).toContain("Plan Mode vs update_plan tool");
    expect(composition).toContain("call `exit_plan_mode` with the complete plan markdown");
    expect(composition).not.toContain("<proposed_plan>");
  });

  it("exposes the package root for DSH client discovery and keeps tools on their own subpath", async () => {
    const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
    const host = await readFile(new URL("../cordis.patch.yml", import.meta.url), "utf8");
    const preset = await readFile(new URL("../agent-presets/codex/agent.cordis.yml", import.meta.url), "utf8");
    expect(manifest.exports["./package.json"]).toBe("./package.json");
    expect(manifest.dsh.client.platform).toBe("web");
    expect(host).toContain("name: '@ryantzhou/dsh-codex'");
    expect(preset).toContain("name: '@ryantzhou/dsh-codex/tools'");
  });
});
