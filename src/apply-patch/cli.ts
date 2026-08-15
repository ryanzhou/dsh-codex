import { applyPatch } from "./index.js";

async function main(): Promise<void> {
  const encoded = process.argv[2];
  if (!encoded) throw new Error("missing base64url patch argument");
  await applyPatch(Buffer.from(encoded, "base64url").toString("utf8"));
  process.stdout.write("Patch applied.\n");
}

main().catch((error: unknown) => {
  process.stderr.write((error instanceof Error ? error.message : String(error)) + "\n");
  process.exitCode = 1;
});
