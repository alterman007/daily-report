/**
 * 团队日报系统 - Vercel serverless 共享工具库
 *
 * 存储：Upstash Redis REST API（Vercel KV 同源）
 *   环境变量（Vercel 项目设置里配置）：
 *     KV_REST_API_URL     例如 https://xxx.kv.upstash.io
 *     KV_REST_API_TOKEN   一长串 token
 *
 * Vercel KV 用户：在 Vercel 项目 Storage 页创建 KV database，
 *   环境变量会自动注入（变量名就是上面这两个）。
 * Upstash 用户：在 upstash.com 创建 database 后复制 REST URL 和 TOKEN。
 */

const crypto = require('crypto');

const KEYS = {
  reports: 'daily:reports',
  members: 'daily:members',
  config:  'daily:config',
  // 记录每天 cron 已经推送过的状态，避免重复推送
  cronSent: 'daily:cron-sent'
};

/* ====== Redis REST 调用 ====== */
// 内存模式：KV_REST_API_URL 以 'memory://' 开头时启用，用于本地开发（local-dev.js）
const memStore = new Map();
function isMemMode() {
  return (process.env.KV_REST_API_URL || '').startsWith('memory://');
}

function redisConfig() {
  return {
    url:  process.env.KV_REST_API_URL  || process.env.UPSTASH_REDIS_REST_URL  || '',
    token:process.env.KV_REST_API_TOKEN|| process.env.UPSTASH_REDIS_REST_TOKEN|| ''
  };
}
function redisAvailable() {
  if (isMemMode()) return true;
  const c = redisConfig();
  return !!(c.url && c.token);
}

async function redisGet(key) {
  if (isMemMode()) {
    const v = memStore.get(key);
    return v === undefined ? null : v;
  }
  const c = redisConfig();
  if (!c.url || !c.token) return null;
  try {
    const r = await fetch(`${c.url}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${c.token}` }
    });
    if (!r.ok) return null;
    const j = await r.json();
    if (j.result === null || j.result === undefined) return null;
    try { return JSON.parse(j.result); } catch { return j.result; }
  } catch { return null; }
}

async function redisSet(key, value) {
  if (isMemMode()) {
    memStore.set(key, value);
    return true;
  }
  const c = redisConfig();
  if (!c.url || !c.token) return false;
  try {
    const r = await fetch(`${c.url}/set/${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${c.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(JSON.stringify(value))
    });
    return r.ok;
  } catch { return false; }
}

/* ====== 业务数据访问层 ====== */
async function getReports() { return (await redisGet(KEYS.reports)) || {}; }
async function saveReports(d) { return await redisSet(KEYS.reports, d); }
async function getMembers()   { return (await redisGet(KEYS.members)) || null; }
async function saveMembers(m)  { return await redisSet(KEYS.members, m); }
async function getConfig() {
  const cfg = (await redisGet(KEYS.config)) || {};
  return Object.assign(
    { webhook: '', secret: '', atMobiles: [], checkTime: '18:00', siteUrl: '' },
    cfg
  );
}
async function saveConfig(c) { return await redisSet(KEYS.config, c); }
async function getCronSent() { return (await redisGet(KEYS.cronSent)) || {}; }
async function saveCronSent(d) { return await redisSet(KEYS.cronSent, d); }

/* ====== 日期工具 ====== */
function pad(n) { return String(n).padStart(2, '0'); }
// 时区：日报按 Asia/Shanghai 算日期，cron 用 UTC
function shanghaiDateStr(date) {
  const d = date || new Date();
  // 转成上海时区字符串
  const opts = { timeZone: 'Asia/Shanghai', year:'numeric', month:'2-digit', day:'2-digit' };
  const parts = new Intl.DateTimeFormat('en-CA', opts).formatToParts(d);
  const y = parts.find(p=>p.type==='year').value;
  const m = parts.find(p=>p.type==='month').value;
  const day = parts.find(p=>p.type==='day').value;
  return `${y}-${m}-${day}`;
}
function shanghaiNow() {
  // 返回上海时区的 {YYYY-MM-DD, HH, MM, weekday}
  const d = new Date();
  const opts = { timeZone: 'Asia/Shanghai', year:'numeric', month:'2-digit', day:'2-digit',
                 hour:'2-digit', minute:'2-digit', weekday: 'short', hour12: false };
  const parts = new Intl.DateTimeFormat('en-CA', opts).formatToParts(d);
  const g = (t) => parts.find(p=>p.type===t)?.value || '';
  return {
    date: `${g('year')}-${g('month')}-${g('day')}`,
    hour: parseInt(g('hour'), 10),
    minute: parseInt(g('minute'), 10),
    weekday: g('weekday')
  };
}

/* ====== 钉钉 ====== */
function buildSignedUrl(webhook, secret) {
  const timestamp = Date.now();
  const stringToSign = `${timestamp}\n${secret}`;
  const hmac = crypto.createHmac('sha256', secret).update(stringToSign).digest('base64');
  const sign = encodeURIComponent(hmac);
  const sep = webhook.indexOf('?') >= 0 ? '&' : '?';
  return `${webhook}${sep}timestamp=${timestamp}&sign=${sign}`;
}

async function postJson(urlStr, bodyObj) {
  try {
    const r = await fetch(urlStr, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(bodyObj)
    });
    const text = await r.text();
    return { ok: r.ok, status: r.status, body: text };
  } catch (e) {
    return { ok: false, status: 0, body: '', error: e.message };
  }
}

async function sendDingTalk(markdown, atMobiles) {
  const config = await getConfig();
  if (!config.webhook) return { ok: false, error: '未配置钉钉 Webhook' };
  const fullUrl = config.secret ? buildSignedUrl(config.webhook, config.secret) : config.webhook;
  const payload = {
    msgtype: 'markdown',
    markdown,
    at: { atMobiles: atMobiles || [], isAtAll: false }
  };
  const r = await postJson(fullUrl, payload);
  let parsed = {};
  try { parsed = JSON.parse(r.body); } catch {}
  if (parsed.errcode === 0) return { ok: true, response: parsed };
  if (r.ok && parsed.errcode === undefined) return { ok: true, response: parsed };
  return { ok: false, error: parsed.errmsg || `HTTP ${r.status}`, response: parsed };
}

/* ====== 检查未填写并通知 ====== */
async function findUnfilled(dateStr) {
  const reports = await getReports();
  const members = (await getMembers()) || [];
  const dayData = reports[dateStr] || {};
  return members.filter(m => {
    const rec = dayData[m];
    return !rec || !(rec.work || '').trim();
  });
}

async function checkAndNotify(dateStr) {
  const config = await getConfig();
  const unfilled = await findUnfilled(dateStr);
  if (unfilled.length === 0) {
    return { ok: true, sent: false, message: '全员已填写，无需通知', unfilled: [] };
  }
  const memberList = unfilled.map(m => `- ${m}`).join('\n');
  const siteUrl = config.siteUrl || '';
  const linkText = siteUrl ? `\n\n> **[前往填写日报](${siteUrl})**` : '';
  const markdown = {
    title: `日报未填写提醒 ${dateStr}`,
    text: `## 📋 日报未填写提醒\n\n**日期**：${dateStr}\n\n以下同事尚未填写今日日报，请尽快补上：\n\n${memberList}${linkText}\n\n— 自动检查来自团队日报系统`
  };
  const atMobiles = (config.atMobiles || []).filter(Boolean);
  const r = await sendDingTalk(markdown, atMobiles);
  return { ...r, unfilled, sent: true };
}

/* ====== HTTP 工具 ====== */
function setCORS(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}
function jsonRes(res, code, obj) {
  setCORS(res);
  res.status(code).json(obj);
}
function readBody(req) {
  return new Promise((resolve) => {
    if (req.body !== undefined) {
      // Vercel 已自动解析
      if (typeof req.body === 'string') return resolve(req.body);
      return resolve(JSON.stringify(req.body));
    }
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => resolve(body));
  });
}
async function parseJsonBody(req) {
  const raw = await readBody(req);
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return {}; }
}

module.exports = {
  KEYS,
  redisConfig, redisAvailable,
  getReports, saveReports,
  getMembers, saveMembers,
  getConfig, saveConfig,
  getCronSent, saveCronSent,
  shanghaiDateStr, shanghaiNow,
  buildSignedUrl, postJson, sendDingTalk,
  findUnfilled, checkAndNotify,
  setCORS, jsonRes, parseJsonBody
};
