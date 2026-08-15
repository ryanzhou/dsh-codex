import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

type Chunk = {
  context?: string;
  oldLines: string[];
  newLines: string[];
  endOfFile: boolean;
};
export type PatchHunk =
  | { kind: "add"; path: string; content: string }
  | { kind: "delete"; path: string }
  | { kind: "update"; path: string; movePath?: string; chunks: Chunk[] };

const HEADERS = ["*** Add File: ", "*** Delete File: ", "*** Update File: "];
const isHeader = (line: string): boolean => HEADERS.some((header) => line.trim().startsWith(header));

function patchLines(input: string): string[] {
  let lines = input.replace(/\r\n?/g, "\n").trim().split("\n");
  const first = lines[0];
  if (["<<EOF", "<<'EOF'", '<<"EOF"'].includes(first ?? "") && lines.at(-1)?.endsWith("EOF")) {
    lines = lines.slice(1, -1);
  }
  if (lines[0]?.trim() !== "*** Begin Patch") {
    throw new Error("The first line of the patch must be '*** Begin Patch'");
  }
  if (lines.at(-1)?.trim() !== "*** End Patch") {
    throw new Error("The last line of the patch must be '*** End Patch'");
  }
  return lines.slice(1, -1);
}

export function parsePatch(input: string): PatchHunk[] {
  const lines = patchLines(input);
  const hunks: PatchHunk[] = [];
  const paths = new Set<string>();
  let i = 0;
  const pathFor = (prefix: string): string => {
    const path = lines[i]!.trim().slice(prefix.length);
    if (!path) throw new Error("invalid hunk at line " + (i + 2) + ", empty path");
    if (paths.has(path)) throw new Error("invalid patch: multiple operations target " + path);
    paths.add(path);
    i++;
    return path;
  };

  while (i < lines.length) {
    const marker = lines[i]!.trim();
    if (marker.startsWith(HEADERS[0]!)) {
      const path = pathFor(HEADERS[0]!);
      const content: string[] = [];
      while (i < lines.length && !isHeader(lines[i]!)) {
        if (!lines[i]!.startsWith("+")) throw new Error("invalid hunk at line " + (i + 2) + ", add file line must start with '+'");
        content.push(lines[i]!.slice(1));
        i++;
      }
      if (content.length === 0) throw new Error("invalid hunk for " + path + ": add file is empty");
      hunks.push({ kind: "add", path, content: content.join("\n") + "\n" });
      continue;
    }
    if (marker.startsWith(HEADERS[1]!)) {
      hunks.push({ kind: "delete", path: pathFor(HEADERS[1]!) });
      continue;
    }
    if (!marker.startsWith(HEADERS[2]!)) {
      throw new Error("invalid hunk at line " + (i + 2) + ", expected file operation");
    }

    const path = pathFor(HEADERS[2]!);
    let movePath: string | undefined;
    if (lines[i]?.trim().startsWith("*** Move to: ")) {
      movePath = lines[i]!.trim().slice("*** Move to: ".length);
      if (!movePath) throw new Error("invalid hunk at line " + (i + 2) + ", empty move path");
      i++;
    }
    const chunks: Chunk[] = [];
    let chunk: Chunk | undefined;
    while (i < lines.length && !isHeader(lines[i]!)) {
      const line = lines[i]!;
      if (line === "@@" || line.startsWith("@@ ")) {
        chunk = { ...(line === "@@" ? {} : { context: line.slice(3) }), oldLines: [], newLines: [], endOfFile: false };
        chunks.push(chunk);
      } else if (line === "*** End of File") {
        if (!chunk) throw new Error("invalid hunk at line " + (i + 2) + ", end-of-file marker without a change");
        chunk.endOfFile = true;
      } else if (["+", "-", " "].includes(line[0] ?? "")) {
        chunk ??= { oldLines: [], newLines: [], endOfFile: false };
        if (!chunks.includes(chunk)) chunks.push(chunk);
        const text = line.slice(1);
        if (line[0] !== "+") chunk.oldLines.push(text);
        if (line[0] !== "-") chunk.newLines.push(text);
      } else {
        throw new Error("invalid hunk at line " + (i + 2) + ", change line must start with '+', '-', or ' '");
      }
      i++;
    }
    if (chunks.length === 0 && !movePath) throw new Error("invalid hunk for " + path + ": update has no changes");
    hunks.push({ kind: "update", path, ...(movePath ? { movePath } : {}), chunks });
  }
  if (hunks.length === 0) throw new Error("invalid patch: at least one file operation is required");
  return hunks;
}

function normalizeUnicode(value: string): string {
  return value.trim().replace(/[‐‑‒–—―−]/g, "-")
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, "\"")
    .replace(/[  -   　]/g, " ");
}

function seek(lines: string[], pattern: string[], start: number, eof: boolean): number {
  const first = eof ? Math.max(start, lines.length - pattern.length) : start;
  const comparisons = [
    (a: string, b: string) => a === b,
    (a: string, b: string) => a.trimEnd() === b.trimEnd(),
    (a: string, b: string) => a.trim() === b.trim(),
    (a: string, b: string) => normalizeUnicode(a) === normalizeUnicode(b),
  ];
  for (const equal of comparisons) {
    for (let i = first; i <= lines.length - pattern.length; i++) {
      if (pattern.every((line, offset) => equal(lines[i + offset]!, line))) return i;
    }
  }
  return -1;
}

export function applyChunks(path: string, source: string, chunks: Chunk[]): string {
  const lines = source.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const replacements: Array<[number, number, string[]]> = [];
  let cursor = 0;
  for (const chunk of chunks) {
    if (chunk.context !== undefined) {
      const context = seek(lines, [chunk.context], cursor, false);
      if (context < 0) throw new Error("Failed to find context '" + chunk.context + "' in " + path);
      cursor = context + 1;
    }
    if (chunk.oldLines.length === 0) {
      replacements.push([lines.length, 0, chunk.newLines]);
      continue;
    }
    const found = seek(lines, chunk.oldLines, cursor, chunk.endOfFile);
    if (found < 0) throw new Error("Failed to find expected lines in " + path + ":\n" + chunk.oldLines.join("\n"));
    replacements.push([found, chunk.oldLines.length, chunk.newLines]);
    cursor = found + chunk.oldLines.length;
  }
  replacements.sort(([a], [b]) => b - a);
  for (const [start, count, replacement] of replacements) lines.splice(start, count, ...replacement);
  return lines.join("\n") + "\n";
}

type Operation = { kind: "write"; path: string; content: string; remove?: string } | { kind: "delete"; path: string };

export async function applyPatch(input: string, cwd = process.cwd()): Promise<void> {
  const operations: Operation[] = [];
  const paths = new Set<string>();
  for (const hunk of parsePatch(input)) {
    const path = resolve(cwd, hunk.path);
    const target = hunk.kind === "update" && hunk.movePath ? resolve(cwd, hunk.movePath) : path;
    for (const candidate of new Set([path, target])) {
      if (paths.has(candidate)) throw new Error("invalid patch: multiple operations target " + candidate);
      paths.add(candidate);
    }
    if (hunk.kind === "add") operations.push({ kind: "write", path, content: hunk.content });
    if (hunk.kind === "delete") {
      await readFile(path, "utf8");
      operations.push({ kind: "delete", path });
    }
    if (hunk.kind === "update") {
      const source = await readFile(path, "utf8");
      operations.push({ kind: "write", path: target, content: applyChunks(hunk.path, source, hunk.chunks), ...(target !== path ? { remove: path } : {}) });
    }
  }
  for (const operation of operations) {
    if (operation.kind === "delete") {
      await rm(operation.path);
      continue;
    }
    await mkdir(dirname(operation.path), { recursive: true });
    await writeFile(operation.path, operation.content, "utf8");
    if (operation.remove) await rm(operation.remove);
  }
}
