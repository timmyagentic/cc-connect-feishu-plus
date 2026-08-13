# Changelog

## 0.2.2 - 2026-08-13

- Create a fully populated CardKit entity before sending or replying with it,
  eliminating the visible blank-card window caused by placeholder conversion.
- Preserve `reply_to_trigger` and thread-isolation behavior while selecting the
  triggering message inside the matching Feishu `root_id`.
- Remove the deprecated CardKit `id_convert` path. If direct CardKit delivery is
  unavailable, retain the populated native card and progressively PATCH that
  same message.
- Follow Codex terminal semantics by keeping the last assistant message as the
  final answer; later tool completions, todo lists, plans, and item updates can
  no longer erase it.
- Support atomic in-place upgrades from existing automatic-proxy releases while
  preserving the original uninstall backup and official CC Connect binary.

## 0.2.1 - 2026-08-13

- Rename the generic tool phase from `正在执行操作…` to the clearer
  `正在调用工具…`.
- Show privacy-safe `推理 N 次 · 工具 N 次` progress on the same locked card
  without exposing reasoning text, tool names, arguments, commands, or output.
- Deduplicate Codex item start/completion pairs with hashed ephemeral item keys,
  including a safe fallback for lifecycle events that omit an item ID.
- Keep early and slow activity visibly fresh while coalescing rapid long bursts
  into bounded progress milestones to avoid excessive full-card updates.
- Remove activity counters when answer preparation starts and keep the final
  card limited to the answer and explicit Done state.

## 0.2.0 - 2026-08-13

- Replace the cooperative MCP implementation with an automatic transparent
  proxy for CC Connect's supported Codex `cmd` option.
- Start a quoted status card concurrently with the real Codex process, then
  keep status and final output in one plugin-owned Card 2.0 message.
- Drop raw reasoning, command, tool argument, and tool output events before
  they reach CC Connect's renderer. Cards expose only fixed non-expandable
  activity labels.
- Return a synthetic `NO_REPLY` completion after the plugin card is finalized,
  while retaining native output as a fail-safe when card takeover fails.
- Add a persistent bundled proxy runtime, reversible config wiring, legacy MCP
  detection, runtime integrity checks, and end-to-end protocol simulation.
- Preserve configured compact local-file reference rendering in plugin-owned
  final cards without exposing absolute paths.
- Support Codex `exec` projects only in this release; incompatible projects are
  left untouched by default and rejected when explicitly selected.

## 0.1.2 - 2026-08-12

- Forward CC Connect's per-turn `CC_PROJECT` and `CC_SESSION_KEY` variables to
  the Codex MCP process through the supported `env_vars` whitelist.
- Add a doctor check that fails when dynamic Feishu turn context cannot reach
  the plugin.
- Resolve Card 2.0 placeholders from a before-send history snapshot and quoted
  reply relationship, because Feishu redacts Card 2.0 body content in message
  history responses.

## 0.1.1 - 2026-08-12

- Preserve each project's existing native `card_mode` instead of forcing the
  legacy renderer. This keeps native Rich Card behavior available as fallback.

## 0.1.0 - 2026-08-12

- First zero-host-change companion-plugin MVP.
- Preserve native CC Connect Feishu routing and quoted replies.
- Add one-card lifecycle with safe activity states, progressive answer chunks,
  explicit Done/error states, and hidden implementation details.
- Prefer CardKit native typewriter updates with same-message PATCH fallback.
- Add reversible npm installer, binary-integrity guard, doctor, and uninstall.
- Add live-config validation and automated host-boundary coverage.
