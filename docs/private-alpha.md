# Private-alpha candidate: setup and recovery

**Validation candidate only — not accepted for tester rollout.** The [acceptance gate](alpha-acceptance.md) is incomplete: the real-project live run exists, but the founder's design-quality assessment and tester-delivery approval are missing. This is Linux-only private validation, not a public release or general compatibility promise.

## Artifact and setup

Build with `npm ci && npm run dist:linux`. Output: `release/Mauxi-0.1.0-x86_64.AppImage`; publishing is disabled. The delivery receipt/checksum identifies the tested bytes—another build can have a different digest even at the same version.

On the declared Linux Mint 22.3/X11 x86_64 environment:

```bash
sha256sum Mauxi-0.1.0-x86_64.AppImage  # compare with the private delivery receipt
chmod +x Mauxi-0.1.0-x86_64.AppImage
PI_TELEMETRY=0 APPIMAGE_EXTRACT_AND_RUN=1 ./Mauxi-0.1.0-x86_64.AppImage
```

Extraction mode was tested; FUSE mounting/desktop integration was not. No root privileges or `--no-sandbox` workaround is required by these instructions. If the sandbox or system libraries fail, preserve the error and stop rather than weakening browser isolation.

The AppImage includes Electron and pi's SDK, **not your project's toolchain**. Install your trusted project's dependencies yourself using its lockfile; ensure its Node/package manager is available to the desktop session. Tested external toolchain: Node 22.23.1/npm 10.9.8. No terminal pi installation is needed. Managed writes also require trusted `/usr/bin/python3`, supported Linux metadata operations, and the project and app recovery vault on the **same filesystem**. ACL/xattr/policy-bearing files may be refused; see [file safety limits](changes-and-recovery.md).

Use disposable, trusted copies with non-production data/accounts. Open project → inspect the plan → Confirm & start → Models & providers → configure/select a model → select a preview element → inspect/remove context → send → give agent control using the scan icon beside Send → inspect the result and the agent's verification summary → repository-title menu → Close project. Review source diffs in your editor/Git; the minimal chat has no diff/Undo panel. Commands and consequential browser interactions require their own approvals. Take back control revokes queued browser actions; Stop also aborts the agent, not an unrelated external server.

Design guidance works in the background: the visual reference library is available automatically, and previously approved personal skills continue loading without design-direction controls. Personal skills are not bundled or licensed for redistribution. See [background design guidance](agent.md) for resource trust and verification limits. Missing guidance is not permission to install packages or claim design quality.

## Known blockers and limits

- Regression suites cover atomic managed replacement, moved-hook conflicts, owned process-group cleanup, storage admission limits, pinned Motion/GSAP, reduced motion, delayed Next streaming and exact JSX provenance. Run them against the current source; they do not complete the alpha acceptance matrix. Turbopack coverage is bridge loading only. Other versions/routers, real projects, live auth, real-model quality and other tester environments remain unverified. See the [remaining private run](real-project-acceptance.md).
- Mobile is a Chromium viewport, not Safari/hardware simulation. Both previews share cookies/storage **inside one workspace**; canonical workspaces have separate browser partitions.

## Local storage, privacy and network behavior

Default profile: `${XDG_CONFIG_HOME:-$HOME/.config}/Mauxi/` (Electron `userData`). Keep it private; it can contain source, images and secrets.

| Location / surface | Policy |
| --- | --- |
| `pi-profile/auth.json` | SDK-owned provider credentials. Not sent to chat/preview or returned as stored secrets to the renderer. Use dedicated login/logout UI. |
| `pi-profile/sessions/` | Native SDK conversations, including submitted code/context/images and tool results. App-wide admission: 512 files / 256 MiB across all workspaces. Every native SDK append (including the deferred first flush) checks capacity. No automatic deletion or age expiry. Sending needs at least 1 MiB headroom; an oversized response can still stop persistence and is reported as potentially unsaved. After freeing space, restart Mauxi; resuming a retained conversation requires a trusted host integration (no renderer history picker). Removing history does not undo code. |
| `captures/` | Disposable selection/preview PNG cache; visible pixels can contain secrets. Admission: 256 files / 128 MiB across workspaces. Selection PNGs are deleted after accepted submission or removal from the draft; unfinished sends and draft attachments are protected. Orphaned selections are cleared on startup. Standalone preview captures expire after 24 hours and may be evicted sooner under capacity pressure; copy exports elsewhere if needed. Individual attachment cap remains 10 MiB. Submitted images remain embedded in native SDK history. |
| `pi-profile/checkpoints/` | 2 MiB/file, 10 MiB/set, scan 2,000 files/20 MiB, 64 retained records; recovery-bearing records stay pinned. |
| `pi-profile/checkpoints/recovery/` | 128 entries/128 MiB admission budget, not a filesystem quota. Preserve unfinished/exposed/displaced data; no automatic expiry. |
| `recovery/` | Instrumentation ownership journals/before-images. At most 64 unfinished records; total admission 128 files / 128 MiB, including completed journals. New instrumentation reserves 2 MiB headroom for bounded before-images and atomic staging. Recovery/cleanup of existing records remains available even at capacity. No automatic pruning. |
| Browser partitions/workspace metadata | Local canonical-workspace storage/layout. Preview storage is separate from provider auth. No claim that arbitrary page JavaScript state survives reopen. |
| Logs/checks | Dev logs retain 400 completed lines of up to 4,000 characters, plus at most 4,000 pending characters even without newlines; command output 120,000 bytes; browser diagnostics 40 entries of 1,200 characters per frame. Redaction is limited, not a guarantee. Native sessions/test traces can retain tool context; review before sharing. |

The packaged interface is served from an ephemeral `127.0.0.1` port so ordinary `SameSite=Lax` preview cookies work. It serves only bundled static UI assets, has no project-file or privileged API, and closes with the app. Preview and shell origins remain distinct; browser partitions, context isolation, sandboxing and IPC sender checks remain enabled.

**No Mauxi-operated cloud sync or analytics backend.** Local-first is not offline: configured providers receive prompts, code/context and images; project pages and approved commands can use the network or reach production systems.

Inherited SDK behavior at pin 0.86.1:

- Mauxi creates `ModelRuntime` with `allowModelNetwork: false` (no initial model-catalog network refresh). The explicit **Refresh catalog** action requests network access. Authentication/login/token refresh and provider availability checks may still contact the configured providers; disabling catalog refresh is not an offline firewall.
- The SDK can discover credentials from the process environment/provider-supported sources in addition to Mauxi's profile. Launch with a clean environment for isolated testing; Mauxi does not import/mutate the terminal's pi profile automatically.
- SDK install/update telemetry is a CLI interactive-mode path, not a path Mauxi invokes. SDK provider-attribution headers are enabled by its default settings; `PI_TELEMETRY=0` disables the optional attribution governed by that flag. Provider protocol/client/session headers (for example OpenCode) may remain. Do not describe that flag as disabling all provider-side telemetry.
- SDK inference/retry/compaction can make provider requests during approved model work. Mauxi currently permits one configured retry, limits runs to 40 model turns/five minutes, and browser verification to 24 calls/four screenshots per run. These are not dollar-budget enforcement. No Mauxi auto-updater is configured.
- Default tests use local fakes and incur no model credits. The 2026-10-15 [real-project run](real-project-acceptance.md) used `openai-codex` / `gpt-6-luna` through the founder's ChatGPT OAuth subscription, as authorized; its usage is in the private receipt. Each further live run needs its own provider/account/budget approval and a spend receipt; never silently spend to fill missing evidence.

## Capacity and explicit cleanup

These are application **admission budgets, not physical disk quotas**. Externally added/growing files can exceed them; subsequent writes are refused. Capacity errors identify the directory, observed file/byte usage, requested growth and limits. Over-budget history/recovery data and protected capture inputs are preserved; disposable capture files follow the cleanup policy below. Captures and SDK writes serialize their checks and writes in the single Electron main process. Bounded scans refuse unexpected entries or more than 4,096 entries instead of silently ignoring them.

### Automatic screenshot cleanup

- Selection PNGs are temporary context: delete them after an accepted send or when their draft chip is removed/replaced/evicted. Failed or rejected sends retain attachments for retry. Separate in-flight references protect asynchronous image reads even if a chip/window disappears.
- Startup clears orphaned selection PNGs because drafts are not restored across launches. Closing/replacing a workspace window or losing its renderer releases its draft pins.
- Standalone **Capture screenshot** PNGs expire after 24 hours. Copy files outside `captures/` for permanent exports; displayed paths are temporary.
- Cleanup runs at startup, hourly while Mauxi is open, before every capture write, and when draft/send references are released. The hourly sweep can remove expired previews up to one interval after expiry.
- Before a write, prune oldest unused previews to a soft target of **192 files / 96 MiB** (75% of both admission limits), including the pending image in the accounting. Protected inputs are never evicted; a single image may exceed the soft target but not the hard limit. If protected or unknown files fill the hard budget, refuse the write instead of deleting them.
- Only recognized, generated, top-level PNG filenames are disposable, including legacy capture names. Unknown/nested files count toward admission but are not deleted. Symlinks, special files and oversized scans fail closed. Cleanup failures are logged; capture writes still enforce the hard admission budget.
- Submitted images are embedded in native SDK conversation history; deleting their disposable PNGs does not prune conversations. Agent browser-verification screenshots are embedded directly and do not use this cache.

There is no automatic expiry of conversations or journals. To reclaim their capacity, stop Mauxi and back up the affected directory. Explicitly choose conversations you no longer need, or instrumentation journals whose state is `clean` and whose cleanup you have verified. Remove only those individually reviewed files. A conversation can contain images/tool output; screenshots may contain sensitive pixels. Never delete an unfinished/conflicted instrumentation journal, retained displaced inode, or checkpoint to bypass a capacity warning. Developer output is not generically redacted; treat all logs as sensitive before sharing.

## Recovery

1. Stop agent work, take back browser control, then close the project normally. Verify cleanup status; an HTTP response or a closed window alone is not proof of cleanup.
2. After a crash, reopen Mauxi to reconcile unfinished instrumentation journals before relaunching. If it reports a conflict, keep the current files and recovery directory; inspect the exact owned region/artifact and retry only after safe resolution. A missing or moved owned file remains a conflict. Journals record config-write intent before mutation. Missing integration text after an attempted write is a conflict unless a durable cleanup receipt matches the current file; older journals without this proof may also require manual recovery. Restore the moved file to its journaled path after reviewing its contents, then retry cleanup. If a cleanup was interrupted before its receipt became durable, preserve the journal and compare all owned paths manually; absence alone cannot prove removal.
3. On checkpoint/disk/capacity failure, stop further writes and free **unrelated disposable** space. Back up current source and app state. Compare individual `intent.json`, `displaced`, and `replacement` files after stopping external writers. Remove only individually reviewed/resolved vault entries. See [detailed recovery](changes-and-recovery.md#recovery-limits-pruning-and-manual-cleanup).
4. Undo is only for the latest backend-eligible managed change set while idle; overlap conflicts must not be overridden. Commands, databases, remote effects, dependency caches and untracked external writes are not generally undoable.
5. Never use `git reset --hard`, blanket `git clean`/stash restoration, lockfile regeneration, bulk journal deletion, or killing by port as Mauxi recovery. When uncertain, preserve data and report the failure with redacted logs and the artifact checksum.
