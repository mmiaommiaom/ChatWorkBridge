# Third-party components and references

ChatWorkBridge's own source is licensed under the MIT License. Third-party components retain their respective licenses. The source repository declares dependencies through npm rather than committing their source or binaries. Windows release archives and installers additionally contain a Node runtime and production npm dependencies so the recipient does not need Node or npm preinstalled. Neither distribution contains browsers, WorkBuddy, models or account data. npm may install additional transitive dependencies, each covered by its own package license.

| Component | License | Use | Source |
| --- | --- | --- | --- |
| Playwright Core | Apache-2.0 | Connect to the user's Chrome and the WorkBuddy desktop renderer over local CDP | https://github.com/microsoft/playwright |
| Model Context Protocol TypeScript SDK | MIT | Constrained local MCP test server and protocol transport | https://github.com/modelcontextprotocol/typescript-sdk |
| Zod | MIT | Input schemas for the local MCP test tools | https://github.com/colinhacks/zod |
| `@electron/asar` | MIT | Optional read-only inspection of a locally installed application archive | https://github.com/electron/asar |
| Node.js | Node.js license (MIT for Node core, with the bundled third-party terms in the complete official LICENSE) | Runtime bundled in Windows binary releases | https://github.com/nodejs/node/blob/main/LICENSE |
| NSIS | Primarily zlib/libpng; its bzip2/LZMA components have their own terms and the documented LZMA linking exception | Creates the Windows installer; its installer stub is part of the generated executable | https://nsis.sourceforge.io/License |

Read the installed packages' LICENSE and NOTICE files for the terms applicable to the exact versions in the lockfile. Windows binary releases retain the complete official Node license at `runtime/node/LICENSE`, NSIS license text at `docs/licenses/NSIS-COPYING.txt`, and dependency notices within `node_modules`. Generated `THIRD_PARTY_COMPONENTS.json` records the included dependency versions and license-file locations. The compiler and development-only ASAR tooling are not included in the application payload. WorkBuddy, Chrome and ChatGPT are third-party products used under their own terms, account requirements and licenses; no rights to those products are granted by this project's MIT License.

## Design references

- https://github.com/dudu555-djiao/codex-workbuddy-gateway
- https://github.com/qayshp/chatgpt-playwright-backend

These public projects were consulted as design references. An established reuse license was not found during the initial review, so their implementation code was not copied into this project. Interoperability with the installed WorkBuddy application was implemented locally from observed communication behavior; the application is not patched or redistributed.

The upstream Model Context Protocol filesystem server was also reviewed as a reference for constrained tooling. Its implementation was not copied or installed in this repository.
