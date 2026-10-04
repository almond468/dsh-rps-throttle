# dsh-rps-throttle

Pre-emptive rate-limit gate for OpenAI-compatible LLM gateways: per-(host, model) pacing with configurable RPS/RPM limits, sliding-window token budgets, and classified 429 handling. Wraps `globalThis.fetch` in the host process via a cordis plugin.

## Origin

This project was built from the author's requirements. **DeepSeek Hermes** autonomously wrote, debugged, and installed the entire plugin. It has been verified to work on both WSL and Windows with DSH v0.2.0-rc.2.

## Problem Background

16 concurrent requests to the same model → 11 get 429. Adding various retry backoffs still leaks. Empirical testing shows at least **three classes** of 429, each requiring completely different handling:

| Response body | Meaning | Correct handling |
| --- | --- | --- |
| `"message":"rps exhausted","code":"8"` | Per-second rate wall (~5 req/s per key+model) | Slow down pace, short backoff retry **works** |
| `"message":"rpm exhausted","code":"8"` | Per-minute request wall (~5 req/min for glm-5.2, deepseek-v4-flash) | **Stop and cool down**. Retrying is counter-productive: retries also consume this minute's window |
| `"inference exceeds tpm/rpm limit"` / `429003` / `insufficient_quota` / `RateLimitExceeded.Endpoint{TPM,RPM}Exceeded` | Per-minute token quota; `Endpoint` = shared gateway saturated | Reduce volume + long backoff; shared endpoint saturation is unsolvable client-side |

Four key empirical conclusions (2026-10-04, same API key):

1. **Quota buckets are per (key, model), not key-wide.** glm-5.2 and deepseek-v4-flash each get ~5 passes/min independently → rate limits must be configured **per model**, not globally.
2. **It's rate/budget, not concurrency.** 1 in-flight with 50ms intervals (~20 rps) still gets 429; 250ms intervals (4 rps) passes. Semaphore-style concurrency limiting is ineffective.
3. **429 has no `Retry-After`, no `x-ratelimit-*`** → backoff duration must be calculated client-side.
4. **No quota query endpoints exist.** `/v1/quota`, `/v1/usage`, `/v1/balance`, `/v1/limits`, `/v1/tokenplan` etc. (18+ routes) all return 404; `/v1/models` metadata has no rpm/tpm fields; docs site is SPA. Only empirical testing works.

### Per-model empirical limits (this key's token plan)

| Model | Observed | Verdict |
| --- | --- | --- |
| sensenova-6.8-flash-lite | 12/12 (24s), 14/14 (14s) all pass; ≥316K tokens/min | **Primary**: only ~5 req/s rate wall, rpm=24 |
| glm-5.2 | 6th request gets `rpm exhausted` | ~5 req/min |
| deepseek-v4-flash | 4th–6th request fails | ~5 req/min |
| deepseek-v4-pro | 0/12 | `RateLimitExceeded.EndpointTPMExceeded/RPMExceeded` — shared endpoint saturation |
| deepseek-flash | 1/12 | Same as above |
| kimi-k3 | 0/12 | Not rate limiting: `field Temperature invalid, only 1 is allowed for this model` |
| sensenova-u1-fast / sensenova-u1.5-lite | 0/12 | `model is not found` (not available on this plan) |
| deepseek-v4.1-flash | 0/12 | `model is not available in the current token plan` |

> Note: `max_tokens:131072` single request (174K prompt tokens) passes, showing flash-lite's per-minute token wall is wide (≥320K/min). **Limits change with plan/subscription; this table is a lower-bound snapshot, not a guarantee.**

## Solution

Wraps `globalThis.fetch`; for requests matching the configured hosts, creates a lane per `host::model` and passes through four gates:

```
Quota cooldown (blockedUntil) → Per-minute request window (rpm) → Token window (tpm, default off) → Per-second rate pacing (rps) → In-flight slots (maxInFlight)
```

Key implementation: **plan send time and synchronously reserve before sleeping**. A naive "check budget → sleep → count on send" approach is invisible to concurrent requests, causing instant budget penetration (caught by self-test ③). Reservations are stored in the sliding window by planned send time; later arrivals see what's already occupied, ensuring FIFO and no over-sending.

Post-wall classification (`classify429`): `rps` type temporarily slows the pace and does inline short-backoff retry (default 2 attempts); `rpm`/`tpm` type **immediately stops inline retry**, cools down the lane for `quotaCooldownMs`, and hands the raw 429 back to the upper layer.

## Coverage and Known Limitations

- Only affects node-side `globalThis.fetch` (the path LLM requests actually take). Non-matching hosts pass through unchanged, no lane created.
- **Cannot create quota from nothing.** If a model only allows 5 req/min, the gate can only make requests wait longer, not faster. Switch models or upgrade the plan.
- Multi-process (GUI + CLI) each count independently, **don't see each other**: two processes using glm-5.2 simultaneously → actual ~10 req/min → will hit the wall; rely on cooldown + retry as fallback.
- Non-replayable bodies (`ReadableStream`/`FormData`/streamed Request) skip inline retry, only throttle the first send.
- No SSE parsing, doesn't affect streaming output; `tpm` token counts are estimated pre-send as `chars × tokensPerChar + max_tokens` (empirically ~1 token : 1.5 chars for mixed CJK/English). Default `tpm: 0` (disabled).
- `Endpoint*Exceeded` is server-side shared endpoint saturation; client-side can only reduce volume + long backoff.

## Why a plugin instead of just editing settings.yaml?

The host has no built-in request rate knobs: searching `app.asar` for `requestsPerMinute` / `tokensPerMinute` / `maxInFlight` / `minIntervalMs` returns **0 hits**. The only legitimate global choke point for LLM outbound traffic is wrapping `globalThis.fetch`, and cordis plugins are the official injection point.

## Division with dsh-retry-boost

| | dsh-rps-throttle (this plugin) | dsh-retry-boost |
| --- | --- | --- |
| Timing | Pre-emptive: prevent wall-hits | Post-hoc: don't fail after wall-hits |
| Method | Rate pacing + minute windows + cooldown | Exponential backoff retry (up to 50 attempts) |
| RPM quota wall | Stop, cool down, hand off to upper layer | Continue long-backoff retry until window slides |
| Using alone | Throttle only, occasional 429 still reaches upper layer | Retry only, no throttle → retries consume more window, worse |

**The two are complementary, not interchangeable.** This plugin explicitly gives up inline retry for `rpm exhausted` specifically so retry-boost can take over with long backoff.

## Requirements

- DSH ≥ 0.1.1-rc.1 (cordis bundle patch), node-side plugin runtime.
- Only affects configured hosts; other providers are unaffected.

## Installation

1. Place the package in the profile's `node_modules`: `~/.dsh/profiles/<name>/node_modules/dsh-rps-throttle/` (contains `package.json` with `dsh.bundle.patch: "./cordis.patch.yml"`).
2. Add to the profile roster `~/.dsh/profiles/<name>/cordis.patch.yml` (the bundled `cordis.patch.yml` is a default template you can copy from):

```yaml
- id: rps-throttle
  name: dsh-rps-throttle
  config:
    enabled: true
    hosts: [token.sensenova.cn, api.sensenova.cn]
    rps: 4
    rpm: 0
    quotaCooldownMs: 20000
    heartbeatFile: /home/<you>/.dsh/tmp/rps-throttle.jsonl
    modelLimits:
      sensenova-6.8-flash-lite: { rps: 4, rpm: 24 }
      glm-5.2:          { rps: 1, rpm: 5 }
      deepseek-v4-flash:{ rps: 1, rpm: 5 }
      deepseek-v4-pro:  { rps: 0.5, rpm: 4 }
      "*":              { rps: 2, rpm: 5 }
```

3. **Critical (not registering = not installed)**: Add the package to the profile's `package.json` — `dsh.profile.bundles` determines which bundles the host mounts, `dependencies` determines whether they survive reinstall:

```jsonc
{
  "dependencies": {
    "dsh-rps-throttle": "file:../../plugins-src/dsh-rps-throttle"
  },
  "dsh": { "profile": { "bundles": [ /* ...existing... */, "dsh-rps-throttle" ] } }
}
```

> Pitfall: doing steps 1–2 and restarting → `heartbeatFile` writes nothing. Roster rows only pass config to **already-mounted** bundles; they don't trigger loading. Third-party packages must appear in `dsh.profile.bundles` (host docs: *"…or list it in a profile's `dsh.profile.bundles`, to insert and mount…"*).
> When both the package's `dsh.bundle.patch` and the profile roster row exist, `apply()` runs twice; the second is skipped by the `PATCHED` symbol guard.

4. Restart DSH, then verify (see below). `heartbeatFile` **must be an absolute path**: the host is an Electron main process, relative paths land in its cwd. The plugin detects this and refuses to write heartbeat explicitly rather than silently writing elsewhere.

## How to Verify It's Working

When host main-process logs are unreadable, use `heartbeatFile` for self-verification:

```bash
tail -1 ~/.dsh/tmp/rps-throttle.jsonl   # Should have {"ev":"load","pid":...,"modelLimits":...}
```

`tick` entries include per-lane `sent / rpmWin / 429(rps,quota) / cd / retry / peakWait`. The `pid` field shows how many distinct values exist → tells you if multi-process each count separately.

## Configuration

| Key | Default | Description |
| --- | --- | --- |
| `enabled` | `true` | Disable = don't wrap fetch at all |
| `hosts` | `["token.sensenova.cn","api.sensenova.cn"]` | Substring/suffix match on hostname; others pass through |
| `rps` | `4` | Fallback per-model requests/second |
| `rpm` | `0` | Fallback requests/minute; `0` = unlimited |
| `maxInFlight` | `4` | Per-model in-flight limit (prevents connection pileup, not quota control) |
| `tpm` / `windowMs` | `0` / `60000` | Token sliding-window budget (default off) and window duration |
| `tokensPerChar` | `0.667` | For pre-send token estimation |
| `maxInlineRetries` | `2` | **Only for rps-type** 429 |
| `quotaCooldownMs` | `20000` | Lane cooldown after rpm/tpm wall hit |
| `initialDelayMs`/`maxDelayMs`/`jitterRatio` | `300`/`4000`/`0.3` | Rps-type inline backoff |
| `logIntervalMs` | `30000` | Periodic stats log; `0` = off |
| `heartbeatFile` / `heartbeatEveryMs` | `""` / `600000` | Load self-verification heartbeat |
| `modelLimits` | `{}` | **Per-model overrides** for the above; key = model id, `"*"` = wildcard |

## Uninstall

Remove the row from the profile's `cordis.patch.yml` and restart (the package directory can stay or be removed).

## Working Principle

See the top comment in `lib/index.js` — empirical conclusions, four-gate order, and the reason for reservation-based sliding windows. Diagnostic entry: `globalThis.__dshRpsThrottle.snapshot()` / `.limitsFor(model)`.

## Development

```bash
node --check lib/index.js
node test/selftest.mjs   # Offline, never connects to network; covers pacing/bucketing/rpm-window-queueing/quota-wall-no-retry
```

## Roadmap

- [ ] Self-learn actual per-model rpm from 429 responses (currently hardcoded from empirical tests)
- [ ] Cross-process shared counting (file lock / local socket)
- [ ] Auto-switch to a model with remaining quota on wall hit (requires host provider hot-switch support)

## Changelog

### 0.0.1

- Added `rpm` per-minute request sliding window and `modelLimits` per-model overrides (empirically glm-5.2 / deepseek-v4-flash only ~5 req/min).
- 429 classified handling: `rpm`/`tpm` types **no longer inline retry**, instead cool down and hand off to upper layer.
- Changed to "plan send time and synchronously reserve before sleeping", fixing concurrent budget penetration.
- Added `heartbeatFile` for load self-verification.

### 0.0.0.1

- Initial release: per-model rate pacing + in-flight limit + optional token sliding window.

## License

MIT
