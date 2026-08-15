import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyPatch, parsePatch } from "../src/apply-patch/index.js";

const patch = (...lines: string[]): string => lines.join("\n");

describe("apply_patch", () => {
  it("accepts the lenient heredoc form emitted by older Codex models", () => {
    expect(parsePatch(patch("<<'EOF'", "*** Begin Patch", "*** Add File: a.txt", "+hello", "*** End Patch", "EOF"))).toEqual([
      { kind: "add", path: "a.txt", content: "hello\n" },
    ]);
  });

  it("plans and applies add, update, move, and delete operations", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "dsh-codex-"));
    await writeFile(join(cwd, "old.txt"), "one\ntwo\nthree\n");
    await writeFile(join(cwd, "delete.txt"), "gone\n");
    await applyPatch(patch(
      "*** Begin Patch",
      "*** Update File: old.txt",
      "*** Move to: nested/new.txt",
      "@@ one",
      "-two",
      "+second",
      " three",
      "*** Delete File: delete.txt",
      "*** Add File: added.txt",
      "+hello",
      "+world",
      "*** End Patch",
    ), cwd);

    expect(await readFile(join(cwd, "nested/new.txt"), "utf8")).toBe("one\nsecond\nthree\n");
    expect(await readFile(join(cwd, "added.txt"), "utf8")).toBe("hello\nworld\n");
    await expect(stat(join(cwd, "old.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(join(cwd, "delete.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("matches typographic punctuation using Codex's final fuzzy pass", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "dsh-codex-"));
    await writeFile(join(cwd, "quote.txt"), "say “hello”\n");
    await applyPatch(patch(
      "*** Begin Patch",
      "*** Update File: quote.txt",
      "@@",
      "-say \"hello\"",
      "+say \"bye\"",
      "*** End Patch",
    ), cwd);
    expect(await readFile(join(cwd, "quote.txt"), "utf8")).toBe("say \"bye\"\n");
  });

  it("places insertion-only chunks after their named context", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "dsh-codex-"));
    await writeFile(join(cwd, "anchor.txt"), "before\nanchor\nafter\n");
    await applyPatch(patch(
      "*** Begin Patch",
      "*** Update File: anchor.txt",
      "@@ anchor",
      "+inserted",
      "*** End Patch",
    ), cwd);
    expect(await readFile(join(cwd, "anchor.txt"), "utf8")).toBe("before\nanchor\ninserted\nafter\n");
  });

  it("rejects duplicate resolved targets before publishing files", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "dsh-codex-"));
    await expect(applyPatch(patch(
      "*** Begin Patch",
      "*** Add File: same.txt",
      "+first",
      "*** Add File: ./same.txt",
      "+second",
      "*** End Patch",
    ), cwd)).rejects.toThrow("multiple operations target");
    await expect(stat(join(cwd, "same.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not publish earlier operations when a later update cannot be planned", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "dsh-codex-"));
    await writeFile(join(cwd, "source.txt"), "actual\n");
    await expect(applyPatch(patch(
      "*** Begin Patch",
      "*** Add File: should-not-exist.txt",
      "+draft",
      "*** Update File: source.txt",
      "@@",
      "-expected",
      "+changed",
      "*** End Patch",
    ), cwd)).rejects.toThrow("Failed to find expected lines");
    await expect(stat(join(cwd, "should-not-exist.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(cwd, "source.txt"), "utf8")).toBe("actual\n");
  });
});
