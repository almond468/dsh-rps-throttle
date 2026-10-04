/**
 * dsh-rps-throttle 自检（离线，不联网）。运行：node test/selftest.mjs
 *
 * 覆盖 5 件事，全部对应实测到的网关行为：
 *   1) 同模型突发被排成匀速节拍（不超过配置 rps）；
 *   2) 不同 model 各自独立计时（实测额度桶挂在 (key, model) 上）；
 *   3) `rpm exhausted` 类 429 → 停止内联重试 + 通道冷却（避免重试风暴自伤）；
 *   4) `rps exhausted` 类 429 → 短退避重试，上层看不到 429；
 *   5) rpm 滑窗到顶时请求**排队等待**而不是失败（windowMs 缩短以便快速验证）。
 */
import assert from "node:assert/strict";
import { format } from "node:util";
import { apply } from "../lib/index.js";

const HOST = "token.sensenova.cn";
const CHAT = `https://${HOST}/v1/chat/completions`;
const body = (model) => JSON.stringify({ model, messages: [{ role: "user", content: "hi" }], max_tokens: 1 });
const res429 = (msg) => new Response(JSON.stringify({ error: { message: msg, type: "quota_exceeded_error", code: "8" } }),
  { status: 429, headers: { "content-type": "application/json" } });
const res200 = () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });

const mkCtx = (sink) => ({ logger: { info: (m, ...a) => sink.push(format(m, ...a)), warn: (m, ...a) => sink.push(format(m, ...a)) } });
const freshFetch = () => { delete globalThis.__dshRpsThrottle; globalThis.fetch = base; };
const base = globalThis.fetch; // 备份真实 fetch，自检绝不联网

async function casePacing() {
  const seen = [];
  let first = true;
  freshFetch();
  globalThis.fetch = async (url, init) => {
    const model = JSON.parse(init.body).model;
    seen.push({ model, at: performance.now() });
    if (model === "deepseek-v4-flash" && first) { first = false; return res429("rps exhausted"); }
    await new Promise((r) => setTimeout(r, 20));
    return res200();
  };
  const logs = [];
  apply(mkCtx(logs), { hosts: [HOST], rps: 4, rpm: 0, maxInFlight: 4, logIntervalMs: 0 });

  const rs = await Promise.all([
    ...Array.from({ length: 8 }, () => fetch(CHAT, { method: "POST", body: body("glm-5.2") }).then((r) => r.status)),
    ...Array.from({ length: 8 }, () => fetch(CHAT, { method: "POST", body: body("deepseek-v4-flash") }).then((r) => r.status)),
  ]);
  const at = (m) => seen.filter((s) => s.model === m).map((s) => s.at).sort((a, b) => a - b);
  const [g, d] = [at("glm-5.2"), at("deepseek-v4-flash")];
  for (let i = 1; i < g.length; i += 1) assert.ok(g[i] - g[i - 1] >= 215, `glm 节拍被压扁：${Math.round(g[i] - g[i - 1])}ms`);
  assert.ok(Math.max(g.at(-1), d.at(-1)) - Math.min(g[0], d[0]) < 2400, "两模型没有分桶并行");
  assert.ok(!rs.includes(429), `rps 类 429 没被消化：${rs.join(",")}`);
  const snap = globalThis.__dshRpsThrottle.snapshot();
  assert.equal(Object.keys(snap).length, 2, `通道数应为 2（按模型分桶），实际 ${Object.keys(snap)}`);
  const ex = await fetch("https://example.com/x", { method: "POST", body: body("x") });
  assert.equal(ex.status, 200, "未命中域名的请求应原样透传");
  assert.equal(Object.keys(globalThis.__dshRpsThrottle.snapshot()).length, 2, "未命中域名被误接管");
  const d429 = snap["token.sensenova.cn::deepseek-v4-flash"];
  assert.equal(d429.retried, 1, "rps 类 429 应内联重试一次");
  console.log("① 匀速节拍 + 按模型分桶 + rps 类 429 内联消化：PASS");
}

async function caseQuotaNoRetryStorm() {
  let hits = 0;
  freshFetch();
  globalThis.fetch = async () => { hits += 1; return res429("rpm exhausted"); };
  apply(mkCtx([]), { hosts: [HOST], rps: 4, rpm: 0, maxInlineRetries: 2, quotaCooldownMs: 1500, logIntervalMs: 0 });

  const rs = await Promise.all(Array.from({ length: 6 }, () => fetch(CHAT, { method: "POST", body: body("deepseek-v4-pro") }).then((r) => r.status)));
  const snap = globalThis.__dshRpsThrottle.snapshot()[`${HOST}::deepseek-v4-pro`];
  assert.ok(rs.every((s) => s === 429), "额度墙应把原始 429 交回上层（由 retry-boost 慢重试）");
  assert.equal(snap.retried, 0, `rpm 类 429 不该内联重试，实际重试 ${snap.retried} 次`);
  assert.ok(snap.cooldowns >= 1, "未进入冷却");
  assert.ok(hits <= 6 + 1, `冷却没挡住后续请求：实际打网关 ${hits} 次`);
  console.log(`② rpm 额度墙：0 次内联重试 + 冷却生效（6 路只打网关 ${hits} 次）：PASS`);
}

async function caseRpmWindowQueues() {
  let t0 = 0;
  const stamps = [];
  freshFetch();
  globalThis.fetch = async () => { stamps.push(performance.now() - t0); return res200(); };
  apply(mkCtx([]), { hosts: [HOST], rps: 100, rpm: 3, windowMs: 3000, maxInFlight: 8, logIntervalMs: 0 });

  t0 = performance.now();
  const rs = await Promise.all(Array.from({ length: 6 }, () => fetch(CHAT, { method: "POST", body: body("glm-5.2") }).then((r) => r.status)));
  assert.ok(rs.every((s) => s === 200), "rpm 排队期间不该有任何失败");
  const late = stamps.sort((a, b) => a - b).slice(3);
  assert.ok(late.every((ms) => ms >= 2600), `第 4~6 发应等到窗口滑出，实际 ${late.map(Math.round).join("/")}ms`);
  console.log(`③ rpm=3/3s 滑窗：前 3 发立走，后 3 发排队 ${late.map((m) => Math.round(m)).join("/")}ms 后全部 200：PASS`);
}

async function main() {
  await casePacing();
  await caseQuotaNoRetryStorm();
  await caseRpmWindowQueues();
  console.log("\n全部自检通过（未产生任何真实网络请求）");
}

main().catch((e) => { console.error("selftest FAIL:", e.message); process.exit(1); });
