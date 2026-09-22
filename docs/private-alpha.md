# Private-alpha candidate: setup and recovery

**Validation candidate only — not accepted for tester rollout.** The [acceptance gate](alpha-acceptance.md) is incomplete, with known safety/Next.js blockers. This is Linux-only private validation, not a public release or general compatibility promise.

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

Use disposable, trusted copies with non-production data/accounts. Open project → inspect the plan → confirm start (or explicitly attach) → Models & providers → configure/select a model → select a preview element → inspect/remove context → send → give agent control for checks → review the actual checks/diff → undo if eligible → close project. Commands and consequential browser interactions require their own approvals. Take back control revokes queued browser actions; Stop also aborts the agent, not an unrelated external server.

Personal design skills/visual catalogs are **not bundled or licensed for redistribution**. Import approved local copies deliberately via [Design guidance](agent.md). Missing guidance is not permission to install packages or claim design quality.

## Known blockers and limits

- [#11](https://github.com/MatiasGigena/Mauxi/issues/11): managed edits can leave Next 16.3.5/Webpack previews stale after a transient missing-file compile error. Do not mistake a settled source diff for a verified result. Stop and retain the diff/logs; do not keep editing an unseen result.
- [#12](https://github.com/MatiasGigena/Mauxi/issues/12): moved owned instrumentation can be silently missed; an early-exiting dev launcher can leave descendants. Normal Vite cycle evidence does not cover these failures. Do not move/checkout instrumented files during validation; record owned process identities before manual investigation. Never kill a process merely because it holds the port.
- [#13](https://github.com/MatiasGigena/Mauxi/issues/13): sessions/captures/completed instrumentation records lack aggregate retention; newline-free dev output is not fully bounded. Disk consumption and sensitive logs need manual attention; delivery remains blocked.
- [#14](https://github.com/MatiasGigena/Mauxi/issues/14): Motion/GSAP and delayed Next streaming evidence is missing. Turbopack only has a bridge smoke. Other versions/routers, real projects, live auth, real-model quality and other tester environments remain unverified.
- Mobile is a Chromium viewport, not Safari/hardware simulation. Both previews share cookies/storage **inside one workspace**; canonical workspaces have separate browser partitions.

## Local storage, privacy and network behavior

Default profile: `${XDG_CONFIG_HOME:-$HOME/.config}/Mauxi/` (Electron `userData`). Keep it private; it can contain source, images and secrets.

| Location / surface | Policy |
| --- | --- |
| `pi-profile/auth.json` | SDK-owned provider credentials. Not sent to chat/preview or returned as stored secrets to the renderer. Use dedicated login/logout UI. |
| `pi-profile/sessions/` | Native SDK conversations, including submitted code/context/images and tool results. No total retention/age limit yet; back up/review while stopped before manual removal. Removing history does not undo code. |
| `captures/` | Selection/preview PNGs; visible pixels can contain secrets. Per-submission selection PNG cap 10 MiB; **no total retention cap**. Remove only reviewed, unneeded captures while stopped, understanding historical links may break. |
| `pi-profile/checkpoints/` | 2 MiB/file, 10 MiB/set, scan 2,000 files/20 MiB, 64 retained records; recovery-bearing records stay pinned. |
| `pi-profile/checkpoints/recovery/` | 128 entries/128 MiB admission budget, not a filesystem quota. Preserve unfinished/exposed/displaced data; no automatic expiry. |
| `recovery/` | Instrumentation ownership journals/before-images. At most 64 unfinished records admitted; completed data has no total retention policy. Do not delete a journal to clear a warning. |
| Browser partitions/workspace metadata | Local canonical-workspace storage/layout. Preview storage is separate from provider auth. No claim that arbitrary page JavaScript state survives reopen. |
| Logs/checks | Dev logs retain 400 completed lines of up to 4,000 characters, with the unresolved pending-line issue above; command output 120,000 bytes; browser diagnostics 40 entries of 1,200 characters per frame. Redaction is limited, not a guarantee. Native sessions/test traces can retain tool context; review before sharing. |

**No Mauxi-operated cloud sync or analytics backend.** Local-first is not offline: configured providers receive prompts, code/context and images; project pages and approved commands can use the network or reach production systems.

Inherited SDK behavior at pin 0.86.1:

- Mauxi creates `ModelRuntime` with `allowModelNetwork: false` (no initial model-catalog network refresh). The explicit **Refresh catalog** action requests network access. Authentication/login/token refresh and provider availability checks may still contact the configured providers; disabling catalog refresh is not an offline firewall.
- The SDK can discover credentials from the process environment/provider-supported sources in addition to Mauxi's profile. Launch with a clean environment for isolated testing; Mauxi does not import/mutate the terminal's pi profile automatically.
- SDK install/update telemetry is a CLI interactive-mode path, not a path Mauxi invokes. SDK provider-attribution headers are enabled by its default settings; `PI_TELEMETRY=0` disables the optional attribution governed by that flag. Provider protocol/client/session headers (for example OpenCode) may remain. Do not describe that flag as disabling all provider-side telemetry.
- SDK inference/retry/compaction can make provider requests during approved model work. Mauxi currently permits one configured retry, limits runs to 16 model turns/five minutes, and browser verification to 24 calls/four screenshots per run. These are not dollar-budget enforcement. No Mauxi auto-updater is configured.
- Default tests use local fakes and incur no model credits. For this acceptance run the founder authorized **$0** and deferred all live-provider tests. A future run needs separate provider/account/budget approval and a spend receipt; never silently spend to fill missing evidence.

## Recovery

1. Stop agent work, take back browser control, then close the project normally. Verify cleanup status; an HTTP response or a closed window alone is not proof of cleanup.
2. After a crash, reopen Mauxi to reconcile unfinished instrumentation journals before relaunching. If it reports a conflict, keep the current files and recovery directory; inspect the exact owned region/artifact and retry only after safe resolution. Moved files need manual comparison due to #12.
3. On checkpoint/disk/capacity failure, stop further writes and free **unrelated disposable** space. Back up current source and app state. Compare individual `intent.json`, `displaced`, and `replacement` files after stopping external writers. Remove only individually reviewed/resolved vault entries. See [detailed recovery](changes-and-recovery.md#recovery-limits-pruning-and-manual-cleanup).
4. Undo is only for the latest backend-eligible managed change set while idle; overlap conflicts must not be overridden. Commands, databases, remote effects, dependency caches and untracked external writes are not generally undoable.
5. Never use `git reset --hard`, blanket `git clean`/stash restoration, lockfile regeneration, bulk journal deletion, or killing by port as Mauxi recovery. When uncertain, preserve data and report the failure with redacted logs and the artifact checksum.
