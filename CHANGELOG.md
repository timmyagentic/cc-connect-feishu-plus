# Changelog

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
