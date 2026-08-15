import { fileURLToPath } from "node:url";
import type { AgentPresets, PresetRoot } from "@deepseek-ai/dsh-agent-presets";

const root: PresetRoot = {
  path: fileURLToPath(new URL("../agent-presets", import.meta.url)),
  trust: "system",
};

type PresetInternals = { resolvedRoots: PresetRoot[] };

export function installPresetRoot(presets: AgentPresets): () => void {
  const roots = (presets as unknown as PresetInternals).resolvedRoots;
  const index = presets.config.includeUserRoot ? roots.length - 1 : roots.length;
  roots.splice(index, 0, root);
  return () => {
    const current = roots.indexOf(root);
    if (current >= 0) roots.splice(current, 1);
  };
}
