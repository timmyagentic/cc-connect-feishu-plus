# Security

## Boundary

CC Connect Feishu Plus does not patch or replace the official CC Connect
binary and does not open a Feishu/Lark event WebSocket. Inbound events,
allowlists, mention rules, session routing, and quoted-reply context remain
owned by CC Connect's native adapter.

## Credentials

The plugin reads the selected project's existing Feishu/Lark application
credentials at runtime. It does not copy those credentials into its install
manifest or turn-state files. Tenant access tokens stay in process memory.

Plugin data under `~/.cc-connect/feishu-plus` is created with directory mode
`0700`; backups, manifests, and state files use `0600`.

## Reporting

Please report security issues privately to the repository owner. Do not place
app secrets, tenant tokens, CC Connect config files, or raw session keys in a
public GitHub issue.
