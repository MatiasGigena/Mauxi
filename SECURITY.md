# Security policy

## Reporting a vulnerability

Report vulnerabilities privately through [GitHub's private vulnerability reporting](https://github.com/MatiasGigena/Mauxi/security/advisories/new). Do not open a public issue, pull request or discussion for a suspected vulnerability.

Include the affected commit or AppImage checksum, your Linux distribution, steps to reproduce and the impact you observed. Redact credentials, provider tokens, private source code and screenshots that show sensitive pages before attaching logs; Mauxi's logs and conversation history are not redacted by default (see [local storage and privacy](docs/usage.md#local-storage-privacy-and-network-behavior)).

You should receive an acknowledgement within seven days. Fixes are made on `main`; there are no maintained release branches.

## Scope

In scope:

- Escapes from the preview boundary: page content reaching host, Node or IPC APIs, forged capabilities, origins or selection IDs, or crossing browser partitions between workspaces.
- Agent actions that bypass command, browser-interaction or file-change approval, or that write outside the opened project.
- Exposure of provider credentials from `pi-profile/auth.json` to the renderer, previews or chat.
- Instrumentation or recovery behavior that destroys user data instead of reporting a conflict.

Out of scope:

- Mauxi is not a general-purpose browser or OS sandbox. Opening an untrusted project, or approving a command or interaction, runs that code with your user's privileges; that is expected behavior. Use trusted projects and development accounts.
- Vulnerabilities in a project you open, in its dependencies, or in model providers.
- Vulnerabilities in Electron, Chromium, the pi SDK or axe-core that Mauxi does not make worse; report those upstream.
- macOS and Windows, which this repository does not support.
