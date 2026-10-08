/**
 * 团队日报系统 - Vercel serverless 共享工具库
 *
 * 存储：Turso (libSQL) 云端 SQLite
 *   环境变量（Vercel 项目设置里配置）：
 *     TURSO_DATABASE_URL   例如 libsql://xxx.turso.io
 *     TURSO_AUTH_TOKEN     一长串 token
 *
 *   本地开发可省略环境变量，用 SQLite 内存模式（local-dev.js 启动时设置 LIBSQL_URL=:memory:）
 *
 * 数据模型：
 *   reports(date, member, work, plan, updated_at)  PK(date, member)
 *   members(name, created_at)                       PK(name)
 *   config(id, webhook, secret, at_mobiles, check_time, site_url)  单行 id=1
 *   cron_sent(date, time, unfilled)                 PK(date)
 */

const crypto = require('crypto');

let _libsqlClient;
try {
  // 动态 require，避免本地无依赖时报错
  _libsqlClient = require('@libsql/client');
} catch (e) {
  _libsqlClient = null;
}

/* ====== 数据库连接 ====== */
function dbConfig() {
  const urlRaw = process.env.TURSO_DATABASE_URL
    || process.env.LIBSQL_URL
    || process.env.DATABASE_URL
    || '';
  const tokenRaw = process.env.TURSO_AUTH_TOKEN
    || process.env.LIBSQL_AUTH_TOKEN
    || process.env.DATABASE_AUTH_TOKEN
    || '';
  return { url: cleanValue(urlRaw), authToken: cleanValue(tokenRaw) };
}
function cleanValue(v) {
  if (!v) return '';
  let s = String(v).trim();
  if ((s.startsWith('`') && s.endsWith('`')) ||
      (s.startsWith('"') && s.endsWith('"')) ||
      (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1).trim();
  }
  return s;
}
function dbAvailable() {
  if (!_libsqlClient) return false;
  const c = dbConfig();
  return !!c.url;
}
let _client = null;
let _initPromise = null;
function getDb() {
  if (_client) return _client;
  if (!_libsqlClient) return null;
  const c = dbConfig();
  if (!c.url) return null;
  _client = _libsqlClient.createClient({
    url: c.url,
    authToken: c.authToken || undefined
  });
  return _client;
}
async function ensureSchema() {
  const db = getDb();
  if (!db) return;
  await db.batch([
    `CREATE TABLE IF NOT EXISTS reports (
      date TEXT NOT NULL,
      member TEXT NOT NULL,
      work TEXT,
      plan TEXT,
      updated_at TEXT,
      PRIMARY KEY (date, member)
    )`,
    `CREATE TABLE IF NOT EXISTS members (
      name TEXT PRIMARY KEY,
      created_at TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS config (
      id INTEGER PRIMARY KEY DEFAULT 1,
      webhook TEXT,
      secret TEXT,
      at_mobiles TEXT,
      check_time TEXT,
      site_url TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS cron_sent (
      date TEXT PRIMARY KEY,
      time TEXT,
      unfilled TEXT
    )`
  ]);
}
async function initOnce() {
  if (!_initPromise) {
    _initPromise = ensureSchema().catch(e => {
      console.error('[initOnce] schema 初始化失败:', e.message);
      // 失败后允许重试
      _initPromise = null;
      throw e;
    });
  }
  return _initPromise;
}

/* ====== 业务数据访问层 ====== */
// 获取所有日报，组装成 {date: {member: {work, plan}}}，兼容老接口
async function getReports() {
  const db = getDb();
  if (!db) return {};
  await initOnce();
  const rs = await db.execute('SELECT date, member, work, plan FROM reports');
  const out = {};
  for (const row of rs.rows) {
    const date = String(row.date);
    const member = String(row.member);
    if (!out[date]) out[date] = {};
    out[date][member] = { work: String(row.work || ''), plan: String(row.plan || '') };
  }
  return out;
}
// 获取单日数据 {member: {work, plan}}
async function getDay(date) {
  const db = getDb();
  if (!db) return {};
  await initOnce();
  const rs = await db.execute({ sql: 'SELECT member, work, plan FROM reports WHERE date=?', args: [date] });
  const out = {};
  for (const row of rs.rows) {
    out[String(row.member)] = { work: String(row.work || ''), plan: String(row.plan || '') };
  }
  return out;
}
// 保存单日数据：删旧插新（事务），高效
async function saveDay(date, dayData) {
  const db = getDb();
  if (!db) return false;
  await initOnce();
  const now = new Date().toISOString();
  const statements = [{ sql: 'DELETE FROM reports WHERE date=?', args: [date] }];
  for (const [member, rec] of Object.entries(dayData || {})) {
    statements.push({
      sql: 'INSERT INTO reports (date, member, work, plan, updated_at) VALUES (?, ?, ?, ?, ?)',
      args: [date, member, rec.work || '', rec.plan || '', now]
    });
  }
  await db.batch(statements);
  return true;
}
// 整体覆盖 reports（兼容旧接口，效率低，不推荐）
async function saveReports(d) {
  const db = getDb();
  if (!db) return false;
  await initOnce();
  const statements = [{ sql: 'DELETE FROM reports' }];
  const now = new Date().toISOString();
  for (const [date, dayData] of Object.entries(d || {})) {
    for (const [member, rec] of Object.entries(dayData || {})) {
      statements.push({
        sql: 'INSERT INTO reports (date, member, work, plan, updated_at) VALUES (?, ?, ?, ?, ?)',
        args: [date, member, rec.work || '', rec.plan || '', now]
      });
    }
  }
  await db.batch(statements);
  return true;
}

async function getMembers() {
  const db = getDb();
  if (!db) return null;
  await initOnce();
  const rs = await db.execute('SELECT name FROM members ORDER BY created_at');
  return rs.rows.map(r => String(r.name));
}
async function saveMembers(members) {
  const db = getDb();
  if (!db) return false;
  await initOnce();
  const now = new Date().toISOString();
  const statements = [{ sql: 'DELETE FROM members' }];
  for (const name of members || []) {
    statements.push({
      sql: 'INSERT INTO members (name, created_at) VALUES (?, ?)',
      args: [String(name), now]
    });
  }
  await db.batch(statements);
  return true;
}

const DEFAULT_CONFIG = { webhook: '', secret: '', atMobiles: [], checkTime: '21:30', siteUrl: '' };
async function getConfig() {
  const db = getDb();
  if (!db) return { ...DEFAULT_CONFIG };
  await initOnce();
  const rs = await db.execute('SELECT webhook, secret, at_mobiles, check_time, site_url FROM config WHERE id=1');
  if (rs.rows.length === 0) return { ...DEFAULT_CONFIG };
  const row = rs.rows[0];
  let atMobiles = [];
  try { atMobiles = JSON.parse(String(row.at_mobiles) || '[]'); } catch {}
  return {
    webhook: String(row.webhook || ''),
    secret: String(row.secret || ''),
    atMobiles,
    checkTime: String(row.check_time || '21:30'),
    siteUrl: String(row.site_url || '')
  };
}
async function saveConfig(c) {
  const db = getDb();
  if (!db) return false;
  await initOnce();
  await db.execute({
    sql: `INSERT INTO config (id, webhook, secret, at_mobiles, check_time, site_url)
          VALUES (1, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            webhook=excluded.webhook,
            secret=excluded.secret,
            at_mobiles=excluded.at_mobiles,
            check_time=excluded.check_time,
            site_url=excluded.site_url`,
    args: [
      c.webhook || '',
      c.secret || '',
      JSON.stringify(c.atMobiles || []),
      c.checkTime || '21:30',
      c.siteUrl || ''
    ]
  });
  return true;
}

async function getCronSent() {
  const db = getDb();
  if (!db) return {};
  await initOnce();
  const rs = await db.execute('SELECT date, time, unfilled FROM cron_sent');
  const out = {};
  for (const row of rs.rows) {
    let unfilled = [];
    try { unfilled = JSON.parse(String(row.unfilled) || '[]'); } catch {}
    out[String(row.date)] = { time: String(row.time || ''), unfilled };
  }
  return out;
}
// 标记单日已推送（推荐用法）
async function markCronSent(date, value) {
  const db = getDb();
  if (!db) return false;
  await initOnce();
  await db.execute({
    sql: `INSERT INTO cron_sent (date, time, unfilled) VALUES (?, ?, ?)
          ON CONFLICT(date) DO UPDATE SET time=excluded.time, unfilled=excluded.unfilled`,
    args: [date, value.time || new Date().toISOString(), JSON.stringify(value.unfilled || [])]
  });
  return true;
}
// 兼容旧接口：整体覆盖
async function saveCronSent(d) {
  const db = getDb();
  if (!db) return false;
  await initOnce();
  const statements = [{ sql: 'DELETE FROM cron_sent' }];
  for (const [date, value] of Object.entries(d || {})) {
    statements.push({
      sql: 'INSERT INTO cron_sent (date, time, unfilled) VALUES (?, ?, ?)',
      args: [date, value.time || new Date().toISOString(), JSON.stringify(value.unfilled || [])]
    });
  }
  await db.batch(statements);
  return true;
}

/* ====== 日期工具 ====== */
function pad(n) { return String(n).padStart(2, '0'); }
function shanghaiDateStr(date) {
  const d = date || new Date();
  const opts = { timeZone: 'Asia/Shanghai', year:'numeric', month:'2-digit', day:'2-digit' };
  const parts = new Intl.DateTimeFormat('en-CA', opts).formatToParts(d);
  const y = parts.find(p=>p.type==='year').value;
  const m = parts.find(p=>p.type==='month').value;
  const day = parts.find(p=>p.type==='day').value;
  return `${y}-${m}-${day}`;
}
function shanghaiNow() {
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
  const members = (await getMembers()) || [];
  const dayData = await getDay(dateStr);
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
  return res.status(code).json(obj);
}
function readBody(req) {
  return new Promise((resolve) => {
    if (req.body !== undefined) {
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
function wrapHandler(handler) {
  return async (req, res) => {
    if (req.method === 'OPTIONS') return jsonRes(res, 204, '');
    try {
      return await handler(req, res);
    } catch (e) {
      console.error('[handler] 未捕获异常:', e);
      return jsonRes(res, 500, {
        ok: false,
        error: e && e.message ? e.message : String(e),
        stack: e && e.stack ? e.stack.split('\n').slice(0, 5).join(' | ') : undefined
      });
    }
  };
}

module.exports = {
  dbConfig, dbAvailable,
  getReports, saveReports, getDay, saveDay,
  getMembers, saveMembers,
  getConfig, saveConfig,
  getCronSent, saveCronSent, markCronSent,
  shanghaiDateStr, shanghaiNow,
  buildSignedUrl, postJson, sendDingTalk,
  findUnfilled, checkAndNotify,
  setCORS, jsonRes, parseJsonBody, wrapHandler
};
