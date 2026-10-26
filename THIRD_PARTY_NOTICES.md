# Third-party components and references

ChatWorkBridge's own source is licensed under the MIT License. Third-party components retain their respective licenses. Dependencies are declared through npm; this repository does not bundle their source code, binaries, browsers, models, or account data. npm may install additional transitive dependencies, each covered by its own package license.

| Component | License | Use | Source |
| --- | --- | --- | --- |
| Playwright Core | Apache-2.0 | Connect to the user's Chrome and the WorkBuddy desktop renderer over local CDP | https://github.com/microsoft/playwright |
| Model Context Protocol TypeScript SDK | MIT | Constrained local MCP test server and protocol transport | https://github.com/modelcontextprotocol/typescript-sdk |
| Zod | MIT | Input schemas for the local MCP test tools | https://github.com/colinhacks/zod |
| `@electron/asar` | MIT | Optional read-only inspection of a locally installed application archive | https://github.com/electron/asar |

Read the installed packages' LICENSE and NOTICE files for the terms applicable to the exact versions in the lockfile. Node.js is a separately installed runtime and retains its own license. WorkBuddy, Chrome and ChatGPT are third-party products used under their own terms, account requirements and licenses; no rights to those products are granted by this project's MIT License.

## Design references

- https://github.com/dudu555-djiao/codex-workbuddy-gateway
- https://github.com/qayshp/chatgpt-playwright-backend

These public projects were consulted as design references. An established reuse license was not found during the initial review, so their implementation code was not copied into this project. Interoperability with the installed WorkBuddy application was implemented locally from observed communication behavior; the application is not patched or redistributed.

The upstream Model Context Protocol filesystem server was also reviewed as a reference for constrained tooling. Its implementation was not copied or installed in this repository.
