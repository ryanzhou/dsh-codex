import { build } from "esbuild";

const id = "@ryantzhou/dsh-codex";
await build({
  entryPoints: ["src/client.tsx"],
  outfile: "dist/client.js",
  bundle: true,
  format: "cjs",
  platform: "browser",
  target: "es2023",
  sourcemap: true,
  external: [
    "react",
    "react/jsx-runtime",
    "@deepseek-ai/dsh-client-ui-primitives",
  ],
  banner: { js: `window.__ModuleLoader__.load({ id: ${JSON.stringify(id)}, factory: (require) => { var module = { exports: {} }; var exports = module.exports;` },
  footer: { js: "return module.exports; } });" },
});
