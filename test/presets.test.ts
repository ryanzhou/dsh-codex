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
});
