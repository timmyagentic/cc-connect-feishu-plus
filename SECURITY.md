# Security

## Boundary

CC Connect Feishu Plus does not patch or replace the official CC Connect
binary and does not open a Feishu/Lark event WebSocket. Inbound events,
allowlists, mention rules, session routing, and quoted-reply context remain
owned by CC Connect's native adapter.

The installed runtime is a transparent child-process proxy configured through
CC Connect's supported Codex `cmd` option. While the plugin owns a Feishu card,
raw reasoning and tool events are discarded before stdout reaches CC Connect.
Only lifecycle metadata and a synthetic `NO_REPLY` completion are forwarded.
If card takeover cannot be established, the proxy passes the native Codex
stream through instead of suppressing the user's result.

## Credentials

The plugin reads the selected project's existing Feishu/Lark application
credentials at runtime. It does not copy those credentials into its install
manifest or turn-state files. Tenant access tokens stay in process memory.

Plugin data under `~/.cc-connect/feishu-plus` is created with directory mode
`0700`; backups, manifests, and short-lived turn-state files use `0600`.
Turn state contains card/session routing identifiers, but never reasoning,
tool arguments, commands, or tool output. The install manifest contains no app
secret, tenant token, or concrete per-turn session ID.

## Reporting

Please report security issues privately to the repository owner. Do not place
app secrets, tenant tokens, CC Connect config files, or raw session keys in a
public GitHub issue.
