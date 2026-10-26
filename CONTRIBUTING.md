# Contributing

Issues and pull requests are welcome. Start with a small reproducible problem and describe the expected behavior.

## Development

Use Windows x64, Node.js 22.13 or newer, and a checkout on a local non-C drive. Run `npm ci` and `npm test`. Unit tests do not log in, call models, or operate your desktop. Manual `scripts/test-*.mjs` probes are separate and require `--live`.

Do not include browser profiles, WorkBuddy profiles, local configuration, task databases, conversation contents, access tokens or signed download links in commits, issues, screenshots or logs. Use synthetic fixtures for tests.

Changes to message delivery should preserve request correlation, durable state and the rule that uncertain or side-effecting operations are never automatically resent. Keep model IDs restricted to the configured policy; do not infer provider prices, balances or reset times.

Windows release tooling is described in [docs/RELEASE.md](docs/RELEASE.md). A packaged installer passing local checks does not establish compatibility with every application version or account.
