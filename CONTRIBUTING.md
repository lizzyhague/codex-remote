# Contributing

English | [中文](CONTRIBUTING.zh-CN.md)

Thank you for helping improve Codex Remote. The project currently targets single-user, self-hosted use; please keep
that boundary clear when proposing features. Multi-user accounts or a hosted service are a much larger design
scope, so please open an issue to discuss them first.

## Development checks

```bash
npm ci
npm run typecheck
npm test
```

For changes involving the real Codex App Server, also run the relevant smoke tests and browser checks in your own
test project. Do not let tests connect to a real project that contains important files.

## What to submit

- Keep changes focused, and add tests for behavior changes;
- Do not commit tokens, real project paths, session content, host names or screenshots with private information;
- When changing the network entry point, keep the application listening only on `127.0.0.1`;
- When changing permission behavior, keep restricted defaults and never turn on full access silently;
- Do not hand-edit `src/generated/` in bulk; regenerate it with the matching Codex CLI and record the version;
- When adding PWA static files, update the static allowlist and its tests; the server generates versioned addresses
  for scripts and styles from their content, so cache names no longer need changing;
- Put interface text in `public/strings.js` with both Chinese and English; backend text for the page is sent as a
  key from the same file.

By submitting a contribution, you confirm that you have the right to provide the code and agree that it is
released under the repository's Apache License 2.0.
