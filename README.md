# CC Connect Feishu Plus

A standalone, installable Feishu/Lark companion plugin for CC Connect.

> Status: early foundation. No npm package has been published yet.

## Design contract

- Keep the official CC Connect binary and its native Feishu adapter.
- Do not replace CC Connect, its updater, or its release channel.
- Do not open a competing Feishu event connection.
- Add capabilities through agent tools (MCP or native agent plugins), supported
  CC Connect hooks, the existing `CC_SESSION_KEY` context, and Feishu OpenAPI.
- Keep installation and removal reversible.

## Planned installation

```bash
npx cc-connect-feishu-plus install
```

The installer does not exist yet. The first implementation will define a
versioned capability contract and will fail closed when the installed CC Connect
version does not expose a required extension point.

## Compatibility boundary

This plugin can add tools and out-of-band Feishu actions without replacing the
native adapter. It cannot rewrite CC Connect's native inbound filtering,
message parsing, session routing, or card renderer unless CC Connect exposes a
stable extension point for that behavior.

## Historical fork

The earlier full-distribution experiment is preserved for reference at
[cc-connect-feishu-plus-legacy-fork](https://github.com/timmyagentic/cc-connect-feishu-plus-legacy-fork).
It is not this plugin and will not be used as the plugin runtime.
