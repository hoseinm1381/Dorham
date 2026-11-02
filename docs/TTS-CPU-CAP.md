# TTS CPU cap operations

Status: deployed on 2026-11-02 and verified in production. TTS, its descendants and cold starts share the 30% total-host CPU cap; the API and other services are uncapped. Both existing 1024 MiB application memory limits are preserved. The host also has a separate intermittent storage/readiness incident documented in SERVER-IO-2026-11-02.md.

## Scope and accounting

Only speech execution is capped. The Go API remains in the delegated service's `app` child; Python/Piper and all descendants run below its sibling `tts`, in a fresh `worker-*` child per worker lifetime. The service parent, API and other services receive no CPU quota. Existing parent memory limits are preserved.

For 30% of total online host capacity, `cpu.max` is `3000 10000` on one vCPU, `6000 10000` on two, and `12000 10000` on four. The quota aggregates all TTS threads and processes. `cpu.max.burst` is zero. Linux enforces scheduled CPU time per period; very short samples may show activity above 30%, while sustained usage is bounded by the quota plus measurement/period boundaries. Repeated cold starts do not rewrite an unchanged quota or reset its accounting period.

The worker is born inside the cgroup via `CLONE_INTO_CGROUP`. Moving an already running Python process into a cgroup would leave startup uncapped and is deliberately avoided. Missing delegation, controller access or clone support prevents speech startup. No unrelated process is moved or terminated.

The persistent `tts` parent is never killed or recreated during worker retirement, so repeated cold starts share one bandwidth budget. Only the individual worker leaf is killed and removed. This also avoids a [reported Linux kill-sequence bug](https://lkml.iu.edu/hypermail/linux/kernel/2608.3/10624.html) that kills later `CLONE_INTO_CGROUP` children when a previously killed cgroup is reused. Isolated testing on the current VPS reproduced that failure with a reused leaf; fresh leaves passed the restart regression.

## Deployment prerequisites

1. Confirm unified cgroup v2, online CPU count, kernel clone support and systemd >=254.
2. Back up the current backend executable, service/drop-in configuration and private environment before changes. Preserve database/uploads and release manifests. Record SHA256 and service identities for rollback.
3. Install the backend executable and the dedicated drop-in from `deployment/dorham-tts-cpu.conf.example`. Keep `MemoryHigh` and `MemoryMax` at their existing values. Inspect only relevant TTS environment keys for overrides: systemd EnvironmentFile entries take precedence over Environment entries.
4. Run `systemctl daemon-reload` and restart only Dorham. Native clients and public download metadata need no changes.
5. Confirm `Delegate=cpu`, `DelegateSubgroup=app`, API membership ending in `/app`, parent/API `cpu.max` beginning with `max`, and speech membership below `/tts/worker-*`. Confirm the intended TTS parent quota and burst zero after a real cold start.

With the CPU cap enabled, the default synthesis deadline is 300 seconds instead of 60. `TTS_TIMEOUT_SECONDS` explicitly configures 1–3600 seconds. Idle retention stays 180 seconds; queue, cooldown, voice membership/authorization, bilingual models, loading announcements and audio-cache limits remain unchanged.

## Required verification

Run the opt-in Linux kernel tests inside a disposable delegated systemd service, using a fresh private evidence directory. They must never run in the production service or database. The suite stresses a parent plus four child processes, measures aggregate `cpu.stat` over sustained load, checks throttling and verifies all descendants start inside the quota. Real installed Piper checks cover English cold/warm, Persian, mixed text, maximum text and idle retirement/restart. Run the real Socket.IO routing/privacy checks against a fresh isolated database as well.

Monitor available memory and public readiness during load; stop only the isolated test unit on guard failure. Compare other service process identities and resource settings before/after. After deployment, verify the production cgroup configuration and real TTS output. Save measurements with sample duration and host CPU count; do not equate one-core percentages with total-host percentages.

## Rollback

Stop only Dorham, restore the verified previous executable and exact previous drop-ins/environment, reload systemd and start Dorham. Verify readiness, client compatibility and other service identities. This change does not migrate the database or alter native installers, public manifests, Piper models or worker script. Keep the previous artifacts until post-deployment checks pass.

## References

- [systemd resource control and delegation](https://www.freedesktop.org/software/systemd/man/261/systemd.resource-control.html)
- [systemd cgroup delegation contract](https://github.com/systemd/systemd/blob/main/docs/CGROUP_DELEGATION.md)
- [Linux cgroup v2 CPU controller](https://www.kernel.org/doc/html/latest/admin-guide/cgroup-v2.html)
- [Linux CLONE_INTO_CGROUP](https://www.man7.org/linux/man-pages/man2/clone.2.html)
- [Go Linux process creation](https://go.dev/src/syscall/exec_linux.go)

## Verification on 2026-11-02

The five-process stress test averaged 29.87% of one host CPU over 18.42 seconds. All descendants started below the TTS quota before their first test code. English cold/warm, Persian, mixed text, 400-character speech, idle retirement/restart and five-process subtree retirement passed. Across the 196-second isolated kernel/Piper run, all 96 public readiness probes succeeded and test memory peaked at 391.3 MiB.

Real Socket.IO routing checks verified English cold/warm and Farsi under the default 180-second idle setting, same-room delivery, outsider denial and epoch invalidation. An intermittent host-storage episode disrupted a later combined-run phase; it is preserved as failed evidence rather than hidden. A focused clean retry of the accelerated idle/restart phase passed both languages, both loading events, all audience checks, all 34 heartbeats (maximum 131.7 ms) and all eight public readiness probes. No production accounts or configuration were modified by those isolated tests.

Local regression checks passed 104 Go tests and 211 Vitest tests, TypeScript checking, focused lint, the web build, and a real two-tab browser check against Go. Native installers were not rebuilt.

Production verification used a temporary private room and two temporary test accounts, all removed afterward. Real English and Farsi speech measured 29.75% and 29.86% total-host CPU. All 30 voice heartbeats succeeded, with a maximum of 37.8 ms. The actual service ran with `Delegate=cpu`, `DelegateSubgroup=app`, `TTS_CPU_PERCENT=30`, a 300-second synthesis deadline, parent/API `cpu.max=max`, and TTS `cpu.max=3000 10000` with burst zero. Public HTML matched the tested payload. Database integrity, original account preservation, other service identities/resource settings and all four native manifest hashes passed. The automatic rollback timer was stopped after these checks; private rollback artifacts remain available. No native installers were rebuilt or republished.
