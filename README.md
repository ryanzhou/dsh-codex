# dsh-codex

A drop-in [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) extension that gives GPT models a Codex-style environment using the native, non-Code-Mode OpenAI Codex tool surface.

Looking to run DeepSeek V4 Flash in Codex instead? See [dsv4-codex-proxy](https://github.com/ryanzhou/dsv4-codex-proxy).

It adds a **Codex-style mode** agent preset with:

- grammar-constrained OpenAI custom tool calls for `apply_patch`;
- Codex-shaped `exec_command`/`write_stdin` unified exec with yielded background sessions and interactive PTY support;
- Codex-shaped `update_plan`, `request_user_input`, and `view_image` function tools;
- the GPT-5.6 Sol Codex system prompt from the user-selected prompt archive;
- DSH's existing sandbox, approval, todo, question, attachment, and tool-presentation behavior underneath the Codex-style wire format.

## Why

GPT-5.6 does not perform as well in DSH's default Standard mode because its post-training expects the prompts, tools, schemas, and result formats used by Codex. Recreating those conventions gives GPT models a familiar environment where their coding behavior feels more at home, while preserving DSH's native experience for DeepSeek models. This makes it practical to use DeepSeek and GPT models side by side in the same DSH installation without forcing either through an unfamiliar agent setup.

## Compatibility

Version 0.2.0 targets DSH 0.1.0-rc.6 and pi-ai 0.82.1. The extension uses small runtime bridges because those DSH versions do not expose grammar metadata or package-provided preset roots as public extension seams. Dependencies are pinned so an incompatible DSH upgrade fails installation instead of silently changing behavior.

Grammar custom tools require a GPT-5+ pi-ai route whose model metadata enables `supportsOpenAIGrammarTools`, such as the built-in OpenAI, OpenAI Codex, Azure OpenAI Responses, GitHub Copilot, opencode, or Cloudflare AI Gateway routes. Unsupported routes receive pi-ai's normal function-tool fallback.

## Install

Install the bundle into every DSH profile where the preset should be available:

~~~sh
dsh plugin --profile web add @ryantzhou/dsh-codex
~~~

After the command completes, restart that DSH process and select **Codex-style mode** when creating a session.

Remove it with the matching package spec:

~~~sh
dsh plugin --profile web remove @ryantzhou/dsh-codex
~~~

## How it works

The DSH bundle inserts one host plugin. At startup it:

1. adds this package's immutable preset directory to the active preset registry;
2. wraps each pi-ai provider once, immediately before dispatch, to attach the `apply_patch` Lark grammar;
3. maps Codex unified exec sessions onto DSH's background-job and PTY primitives;
4. removes the delegate schemas and their tool-specific guidance from Codex prompt assemblies.

The Codex tools themselves delegate to DSH's existing `bash`/`pwsh`, `todo_write`, `ask_user_question`, and `read_image` tools. This keeps policy enforcement and UI behavior in their existing owners. `apply_patch` runs the bundled parser and applicator through the same sandboxed shell delegate.

## Development

~~~sh
corepack pnpm install
corepack pnpm check
corepack pnpm test
corepack pnpm build
corepack pnpm pack
~~~

## License

Original code is MIT licensed. Codex-derived grammar and behavioral references retain OpenAI's Apache-2.0 notice. The archived GPT-5.6 prompt is not covered by this project's MIT license; its collector applies CC0 but does not warrant third-party rights. See `NOTICE` and `THIRD_PARTY_LICENSES`.
