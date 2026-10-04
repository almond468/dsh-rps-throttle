/**
 * dsh-rps-throttle — Per-model request pacing gate for OpenAI-compatible LLM gateways.
 *
 * Empirically derived (2026-10-04, token.sensenova.cn, same API key):
 *   1) Three classes of 429 require different handling:
 *      - {"error":{"message":"rps exhausted","type":"quota_exceeded_error","code":"8"}}
 *        → Per-second rate wall. Short backoff + retry works.
 *      - {"error":{"message":"rpm exhausted","type":"quota_exceeded_error","code":"8"}}
 *        → Per-minute request wall (~5 req/min for glm-5.2, deepseek-v4-flash).
 *          Retrying is counter-productive (retries also consume the window).
 *          Correct action: stop, cool down the lane until the window slides.
 *      - {"message":"inference exceeds tpm/rpm limit"} / 429003 / insufficient_quota
 *        / RateLimitExceeded.Endpoint{TPM,RPM}Exceeded
 *        → Per-minute token quota. "Endpoint*" = shared gateway saturated —
 *          client-side throttling cannot fix this; only reduce volume + long backoff.
 *   2) Quota buckets are per (key, model), NOT key-wide: glm-5.2 and
 *      deepseek-v4-flash each get ~5 passes/min independently; flash-lite gets 14/14.
 *      → Rate limits must be configured per model, not globally.
 *   3) It's rate/budget, not concurrency: 1 in-flight with 50ms intervals (~20 rps)
 *      still gets 429; 250ms intervals (4 rps) passes. Semaphore-style concurrency
 *      limiting is ineffective.
 *   4) No Retry-After header, no x-ratelimit-* headers → backoff duration must be
 *      calculated client-side.
 *
 * Key implementation: plan send time and synchronously reserve before sleeping.
 * A naive "check budget → sleep → count on send" approach is invisible to
 * concurrent requests, causing instant budget penetration. Reservations are stored
 * in the sliding window by planned send time; later arrivals see what's already
 * occupied, ensuring FIFO and no over-sending.
 *
 * Division with dsh-retry-boost: this plugin prevents wall-hits and stops loss
 * after them; retry-boost handles "don't fail even after wall-hits".
 * Note: throttling can only queue requests, not create quota. If a model only
 * allows 5 req/min, smarter throttling just makes requests wait longer, not faster.
 *
 * Plugin contract (same as dsh-retry-boost): `export const name` +
 * `export function apply(ctx, config)`, runs in the host process.
 * Multi-process (GUI + CLI) each count independently; they don't see each other.
 */

/** Plugin identity, must match the cordis.patch.yml roster row id. */
export const name = "rps-throttle";

/** Prevent double-wrapping: Symbol.for is unique across module instances. */
const PATCHED = Symbol.for("dsh.rpsThrottle.patched");

const DEFAULTS = {
  enabled: true,
  /** Only intercept these domains (substring match); other providers pass through. */
  hosts: ["token.sensenova.cn", "api.sensenova.cn"],
  /** Fallback per-model requests-per-second. Empirically ~5 rate wall, use 4 for margin. */
  rps: 4,
  /** Fallback per-model requests-per-minute; 0 = unlimited (rate pacing only). */
  rpm: 0,
  /** Per-model in-flight request limit. */
  maxInFlight: 4,
  /** Per-model sliding-window token budget; 0 = disabled. */
  tpm: 0,
  /** Sliding window duration in ms (shared by rpm and tpm). */
  windowMs: 60000,
  /** Char-to-token conversion ratio (pre-send cost estimate). Empirically ~1 token : 1.5 chars. */
  tokensPerChar: 0.667,
  /** Max inline retries after rps-type 429. */
  maxInlineRetries: 2,
  /** Lane cooldown duration (ms) after rpm/tpm-type 429. */
  quotaCooldownMs: 20000,
  initialDelayMs: 300,
  maxDelayMs: 4000,
  jitterRatio: 0.3,
  /** Periodic stats log interval; 0 = disabled. */
  logIntervalMs: 30000,
  /**
   * Heartbeat file (node-side absolute path, JSONL append). Empty = disabled.
   * Purpose: self-verify that the host actually loaded this plugin when no logs
   * are available. Writes `ev:"load"` on startup (with pid to detect multi-process)
   * and `ev:"tick"` every `heartbeatEveryMs` (with per-lane stats).
   */
  heartbeatFile: "",
  /** Minimum heartbeat interval in ms. */
  heartbeatEveryMs: 600000,
  /**
   * Per-model limit overrides (key = model id, exact match; "*" = wildcard).
   * Numbers from empirical tests at the top of this file.
   * Example: `{ "glm-5.2": { rpm: 5, rps: 1 } }`
   */
  modelLimits: {},
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : d);

/** @param {any} raw @param {object} base @returns {object} per-model limits */
function mergeLimits(raw, base) {
  if (!raw || typeof raw !== "object") return base;
  const out = { ...base };
  for (const k of ["rps", "rpm", "maxInFlight", "tpm", "quotaCooldownMs"]) {
    if (raw[k] !== undefined && raw[k] !== null) out[k] = num(raw[k], out[k]);
  }
  out.rps = Math.max(0.05, out.rps);
  out.maxInFlight = Math.max(1, Math.floor(out.maxInFlight));
  return out;
}

/** @param {any} config @returns {object} normalized config with defaults merged */
function normalizeConfig(config = {}) {
  const cfg = { ...DEFAULTS, ...config };
  cfg.hosts = (Array.isArray(cfg.hosts) ? cfg.hosts : [cfg.hosts])
    .map((h) => String(h).toLowerCase())
    .filter(Boolean);
  cfg.rps = Math.max(0.05, num(cfg.rps, DEFAULTS.rps));
  cfg.rpm = Math.max(0, num(cfg.rpm, 0));
  cfg.maxInFlight = Math.max(1, Math.floor(num(cfg.maxInFlight, DEFAULTS.maxInFlight)));
  cfg.tpm = Math.max(0, num(cfg.tpm, 0));
  cfg.windowMs = Math.max(1000, num(cfg.windowMs, 60000));
  cfg.tokensPerChar = num(cfg.tokensPerChar, DEFAULTS.tokensPerChar) || DEFAULTS.tokensPerChar;
  cfg.maxInlineRetries = Math.max(0, Math.floor(num(cfg.maxInlineRetries, 2)));
  cfg.quotaCooldownMs = Math.max(0, num(cfg.quotaCooldownMs, DEFAULTS.quotaCooldownMs));
  cfg.modelLimits = cfg.modelLimits && typeof cfg.modelLimits === "object" ? cfg.modelLimits : {};
  /** @type {Map<string, object>} resolved limits cache */
  cfg._cache = new Map();
  return cfg;
}

/**
 * Resolve limits for a model: exact match → "*" wildcard → fallback.
 * @param {object} cfg @param {string} model
 */
function limitsFor(cfg, model) {
  if (cfg._cache.has(model)) return cfg._cache.get(model);
  const table = cfg.modelLimits || {};
  let raw = table[model];
  if (raw === undefined && Object.prototype.hasOwnProperty.call(table, "*")) raw = table["*"];
  const lim = mergeLimits(raw, {
    rps: cfg.rps, rpm: cfg.rpm, maxInFlight: cfg.maxInFlight,
    tpm: cfg.tpm, quotaCooldownMs: cfg.quotaCooldownMs,
  });
  cfg._cache.set(model, lim);
  return lim;
}

/**
 * Exponential backoff with jitter when 429 has no Retry-After.
 * @param {number} attempt starting from 0 @param {object} cfg
 */
function backoffMs(attempt, cfg) {
  const base = Math.min(cfg.maxDelayMs, cfg.initialDelayMs * 2 ** attempt);
  const j = cfg.jitterRatio;
  return Math.max(0, Math.round(base * (1 - j + Math.random() * 2 * j)));
}

/** @param {Headers} headers @returns {number|null} Retry-After in ms */
function retryAfterMs(headers) {
  try {
    const v = headers?.get?.("retry-after");
    if (!v) return null;
    const sec = Number(v);
    if (Number.isFinite(sec)) return Math.max(0, sec * 1000);
    const d = Date.parse(v);
    return Number.isNaN(d) ? null : Math.max(0, d - Date.now());
  } catch {
    return null;
  }
}

/**
 * Classify 429: decide "short backoff retry" vs "stop immediately and cool down".
 * @param {string} text response body @returns {"rps"|"quota"}
 */
function classify429(text) {
  const s = String(text || "").toLowerCase();
  if (s.includes("rps exhausted")) return "rps";
  if (s.includes("rpm") || s.includes("tpm") || s.includes("429003")
    || s.includes("insufficient_quota") || s.includes("exceeds")
    || s.includes("quota") || s.includes("rate_limit")) return "quota";
  return "rps"; // Unknown format treated as rate wall: backoff once then hand off
}

/** Single (host, model) lane. */
class Lane {
  constructor(limits) {
    this.limits = limits;
    this.nextAt = 0;
    this.inFlight = 0;
    this.waiters = [];
    /** @type {number[]} reserved planned send times (ascending), rpm sliding window */
    this.reqWindow = [];
    /** @type {[number, number][]} [planned time, estimated tokens], tpm sliding window */
    this.tokenWindow = [];
    this.blockedUntil = 0;
    this.sent = 0;
    this.paced = 0;
    this.pacedMs = 0;
    this.limitedRps = 0;
    this.limitedQuota = 0;
    this.cooldowns = 0;
    this.retried = 0;
    this.maxWaitMs = 0;
  }
}

class Throttle {
  constructor(cfg) {
    this.cfg = cfg;
    /** @type {Map<string, Lane>} */
    this.lanes = new Map();
  }

  lane(key, model) {
    let l = this.lanes.get(key);
    if (!l) {
      l = new Lane(limitsFor(this.cfg, model));
      this.lanes.set(key, l);
    }
    return l;
  }

  /** Estimate token cost before send: input by char conversion + output by max_tokens. */
  estimate(lane, bodyText) {
    const cfg = this.cfg;
    if (!lane.limits.tpm) return 1;
    let chars = 0;
    let maxTokens = 0;
    try {
      const j = JSON.parse(bodyText);
      const msg = typeof j.messages === "string" ? j.messages : JSON.stringify(j.messages ?? j.input ?? "");
      chars = msg.length;
      maxTokens = Number(j.max_tokens ?? j.max_completion_tokens ?? j.max_output_tokens) || 0;
    } catch {
      chars = String(bodyText || "").length;
    }
    return Math.ceil(chars * cfg.tokensPerChar) + maxTokens + 8;
  }

  /**
   * Pure arithmetic planning: calculate when this request should be sent,
   * and immediately write the reservation into the sliding window so concurrent
   * arrivals can see the already-occupied budget. Does not call sleep.
   * @param {Lane} lane @param {number} cost @param {number} now
   * @returns {number} planned send time (epoch ms)
   */
  plan(lane, cost, now) {
    const cfg = this.cfg;
    const lim = lane.limits;
    const W = cfg.windowMs;
    let at = Math.max(now, lane.blockedUntil);
    at = Math.max(at, lane.nextAt);
    lane.nextAt = at + 1000 / lim.rps; // Rate slot: each request occupies 1/rps seconds, natural FIFO

    if (lim.rpm) {
      for (;;) {
        const cutoff = at - W;
        let i = 0;
        while (i < lane.reqWindow.length && lane.reqWindow[i] <= cutoff) i += 1;
        if (i > 0) lane.reqWindow.splice(0, i);
        if (lane.reqWindow.length < lim.rpm) break; // Window has room
        at = lane.reqWindow[0] + W; // Otherwise wait for earliest entry to slide out (strictly increasing, always converges)
      }
      lane.reqWindow.push(at);
    }

    if (lim.tpm) {
      for (;;) {
        const cutoff = at - W;
        let i = 0;
        while (i < lane.tokenWindow.length && lane.tokenWindow[i][0] <= cutoff) i += 1;
        if (i > 0) lane.tokenWindow.splice(0, i);
        const used = lane.tokenWindow.reduce((s, [, t]) => s + t, 0);
        if (used + cost <= lim.tpm) break;
        at = lane.tokenWindow[0][0] + W;
      }
      lane.tokenWindow.push([at, cost]);
    }
    return at;
  }

  /** Undo this reservation (called when re-scheduled during cooldown). */
  unplan(lane, at, cost) {
    if (lane.limits.rpm && lane.reqWindow.at(-1) === at) lane.reqWindow.pop();
    const last = lane.tokenWindow.at(-1);
    if (lane.limits.tpm && last && last[0] === at && last[1] === cost) lane.tokenWindow.pop();
  }

  /**
   * Acquire send permission.
   * @param {string} key @param {string} model @param {number} cost
   * @returns {Promise<() => void>} release (idempotent)
   */
  async enter(key, model, cost) {
    const lane = this.lane(key, model);
    const lim = lane.limits;
    const t0 = Date.now();

    for (let guard = 0; ; guard += 1) {
      const now = Date.now();
      const at = this.plan(lane, cost, now);
      const wait = at - now;
      if (wait > 0) {
        lane.paced += 1;
        lane.pacedMs += wait;
        await sleep(wait);
      }
      // If another request hit the quota wall during sleep, re-plan (reservation invalidated),
      // don't let this batch continue crashing into the wall
      if (lane.blockedUntil > Date.now() && guard < 8) {
        this.unplan(lane, at, cost);
        continue;
      }
      break;
    }

    // In-flight slots: not quota-related, just prevent connection pileup
    if (lane.inFlight >= lim.maxInFlight) {
      const w = Date.now();
      await new Promise((resolve) => lane.waiters.push(resolve));
      lane.pacedMs += Date.now() - w;
    }
    lane.inFlight += 1;
    lane.sent += 1;
    lane.maxWaitMs = Math.max(lane.maxWaitMs, Date.now() - t0);

    let done = false;
    return () => {
      if (done) return;
      done = true;
      lane.inFlight -= 1;
      lane.waiters.shift()?.();
    };
  }

  /**
   * Record a 429 hit.
   * @param {string} key @param {string} model @param {"rps"|"quota"} kind
   * @returns {boolean} true = entered cooldown (should not inline retry)
   */
  noteLimited(key, model, kind) {
    const lane = this.lane(key, model);
    if (kind === "quota") {
      lane.limitedQuota += 1;
      const until = Date.now() + lane.limits.quotaCooldownMs;
      if (until > lane.blockedUntil) {
        lane.blockedUntil = until;
        lane.cooldowns += 1;
      }
      return true;
    }
    lane.limitedRps += 1;
    // Rate wall: temporarily slow the pace (double interval), more effective than blind retry
    lane.nextAt = Math.max(lane.nextAt, Date.now() + 2000 / lane.limits.rps);
    return false;
  }

  noteRetry(key, model) { this.lane(key, model).retried += 1; }

  snapshot() {
    const out = {};
    for (const [k, l] of this.lanes) {
      out[k] = {
        limit: `rps=${l.limits.rps} rpm=${l.limits.rpm || "∞"} inflight=${l.limits.maxInFlight} tpm=${l.limits.tpm || "off"}`,
        sent: l.sent, paced: l.paced, pacedMs: l.pacedMs, maxWaitMs: l.maxWaitMs,
        inFlight: l.inFlight, rps429: l.limitedRps, quota429: l.limitedQuota,
        cooldowns: l.cooldowns, retried: l.retried,
        rpmWindow: l.reqWindow.length, tpmWindow: l.tokenWindow.reduce((s, [, t]) => s + t, 0),
      };
    }
    return out;
  }
}

/**
 * Extract url / reusable body text / model from fetch parameters.
 * @param {any} input @param {any} init
 */
function describe(input, init) {
  let url = null;
  let body = init?.body;
  let method = init?.method;

  if (typeof input === "string" || input instanceof URL) {
    url = String(input);
  } else if (input && typeof input === "object" && typeof input.url === "string") {
    url = input.url; // Request object
    if (body === undefined) body = input.body ?? null;
    method = method ?? input.method;
  }
  if (!url) return null;

  let text = null;
  let reusable = true;
  if (body == null) {
    reusable = false;
  } else if (typeof body === "string") {
    text = body;
  } else if (body instanceof Uint8Array) {
    text = new TextDecoder().decode(body);
  } else if (body instanceof ArrayBuffer) {
    text = new TextDecoder().decode(new Uint8Array(body));
  } else {
    reusable = false; // ReadableStream / FormData etc. are not replayable
  }

  let model = "*";
  if (text) {
    try {
      model = JSON.parse(text).model || "*";
    } catch {
      /* Non-JSON body: use wildcard limits */
    }
  }
  return { url, text, model, reusable, method: (method || (text ? "POST" : "GET")).toUpperCase() };
}

/** @param {string} url @param {string[]} hosts */
function matches(url, hosts) {
  try {
    const h = new URL(url).hostname.toLowerCase();
    return hosts.some((s) => h === s || h.endsWith(s) || h.includes(s));
  } catch {
    return hosts.some((s) => url.toLowerCase().includes(s));
  }
}

/** Best-effort read 429 body for classification; returns empty string on failure (doesn't block request). */
async function peek429(res) {
  try {
    const clone = res.clone?.();
    if (!clone) return "";
    return await Promise.race([
      clone.text(),
      new Promise((r) => setTimeout(() => r(""), 1500)),
    ]);
  } catch {
    return "";
  }
}

/**
 * @param {import("@deepseek-ai/cordis").Context} ctx cordis plugin context
 * @param {object} [config] config from the roster row (see cordis.patch.yml)
 */
export function apply(ctx, config = {}) {
  const cfg = normalizeConfig(config);
  const log = (msg, ...a) => (ctx?.logger?.info ? ctx.logger.info(msg, ...a) : console.info(msg, ...a));
  const warn = (msg, ...a) => (ctx?.logger?.warn ? ctx.logger.warn(msg, ...a) : console.warn(msg, ...a));

  // heartbeatFile must be an absolute path: the host is an Electron main process,
  // relative paths land in its cwd (unpredictable).
  if (cfg.heartbeatFile && !/^([A-Za-z]:[\\/]|[\\/])/u.test(cfg.heartbeatFile)) {
    warn("dsh-rps-throttle: heartbeatFile requires absolute path, heartbeat ignored (current: %s)", cfg.heartbeatFile);
    cfg.heartbeatFile = "";
  }

  if (!cfg.enabled) {
    log("dsh-rps-throttle: disabled by config");
    return;
  }
  if (typeof globalThis.fetch !== "function") {
    warn("dsh-rps-throttle: globalThis.fetch not found, not enabled");
    return;
  }
  if (globalThis.fetch[PATCHED]) {
    log("dsh-rps-throttle: fetch already wrapped, skipping (idempotent)");
    return;
  }

  const throttle = new Throttle(cfg);
  const upstream = globalThis.fetch.bind(globalThis);

  /** Diagnostic entry: read globalThis.__dshRpsThrottle.snapshot() from inside the host. */
  globalThis.__dshRpsThrottle = {
    config: cfg,
    throttle,
    snapshot: () => throttle.snapshot(),
    limitsFor: (model) => limitsFor(cfg, model),
  };

  /**
   * Heartbeat: proves the host actually called this plugin's apply().
   * Async import to avoid bundling errors on the browser side.
   * @param {"load"|"tick"} ev @param {object} extra
   */
  let lastBeat = 0;
  const beat = (ev, extra) => {
    if (!cfg.heartbeatFile) return;
    if (ev !== "load" && Date.now() - lastBeat < cfg.heartbeatEveryMs) return;
    lastBeat = Date.now();
    import("node:fs")
      .then((fs) => fs.appendFileSync(cfg.heartbeatFile,
        JSON.stringify({ at: new Date().toISOString(), ev, pid: process.pid, ...extra }) + "\n"))
      .catch(() => { /* Read-only env or missing path: ignore, don't affect requests */ });
  };

  const wrapped = async function fetchThrottled(input, init) {
    const d = describe(input, init);
    if (!d || !matches(d.url, cfg.hosts)) return upstream(input, init);

    const host = new URL(d.url).hostname.toLowerCase();
    const key = `${host}::${d.model}`;
    const lane = throttle.lane(key, d.model);
    const release = await throttle.enter(key, d.model, throttle.estimate(lane, d.text ?? ""));
    try {
      let attempt = 0;
      for (;;) {
        const res = await upstream(input, init);
        if (res.status !== 429) return res;

        const cooling = throttle.noteLimited(key, d.model, classify429(await peek429(res)));
        // Quota wall (rpm/tpm): inline retry only consumes more of the window, hand off to upper layer
        if (!d.reusable || cooling || attempt >= cfg.maxInlineRetries) return res;

        const wait = retryAfterMs(res.headers) ?? backoffMs(attempt, cfg);
        attempt += 1;
        throttle.noteRetry(key, d.model);
        await sleep(wait);
      }
    } finally {
      release();
    }
  };
  wrapped[PATCHED] = true;
  globalThis.fetch = wrapped;

  const limitsLine = Object.keys(cfg.modelLimits).length ? JSON.stringify(cfg.modelLimits) : "(no overrides)";
  log("dsh-rps-throttle: hosts=%s fallback rps=%s rpm=%s inflight=%s | per-model %s",
    cfg.hosts.join(","), cfg.rps, cfg.rpm || "∞", cfg.maxInFlight, limitsLine);
  beat("load", { hosts: cfg.hosts, rps: cfg.rps, rpm: cfg.rpm, modelLimits: cfg.modelLimits });

  const tick = () => {
    try {
      const snap = throttle.snapshot();
      if (Object.keys(snap).length === 0) return;
      const line = Object.entries(snap)
        .map(([k, v]) => `${String(k).split("::").pop()}: sent=${v.sent} rpmWin=${v.rpmWindow}`
          + ` 429(rps=${v.rps429},quota=${v.quota429}) cd=${v.cooldowns} retry=${v.retried}`
          + ` peakWait=${v.maxWaitMs}ms inflight=${v.inFlight}`)
        .join(" | ");
      log(`dsh-rps-throttle: ${line}`);
      beat("tick", { snap });
    } catch {
      /* Log failure must not affect requests */
    }
  };
  if (cfg.logIntervalMs > 0 && typeof setInterval === "function") {
    const timer = setInterval(tick, cfg.logIntervalMs);
    timer.unref?.();
  }
  if (cfg.heartbeatFile && cfg.tickOnStart !== false) {
    // Heartbeat independent of log interval: prove "host loaded me" even without traffic
    const hb = setInterval(() => {
      beat("tick", { idle: true, sent: [...throttle.lanes.values()].reduce((s, l) => s + l.sent, 0) });
    }, Math.max(10000, cfg.heartbeatEveryMs));
    hb.unref?.();
  }
}

export default { name, apply };
