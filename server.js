#!/usr/bin/env node
/**
 * 团队日报系统 - 后端服务（零依赖，仅用 Node.js 内置模块）
 *
 * 功能：
 *   1. 静态托管 daily-report.html
 *   2. 日报数据 / 成员 / 钉钉配置 持久化到 data/ 目录
 *   3. 转发钉钉机器人消息（解决前端 CORS，支持加签）
 *   4. 定时自动检查当天未填写并推送到钉钉
 *
 * 启动：
 *   node server.js                 # 默认端口 3000，自动检查时间 18:00
 *   PORT=8080 node server.js       # 自定义端口
 *   CHECK_TIME=17:30 node server.js  # 自定义自动检查时间
 *
 * 前端会自动检测后端是否存在：未连接时仅本地编辑可用，连接后钉钉功能启用。
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const REPORTS_FILE = path.join(DATA_DIR, 'reports.json');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const MEMBERS_FILE = path.join(DATA_DIR, 'members.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

/* ====== 数据读写 ====== */
function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return fallback; }
}
function writeJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}
function getReports() { return readJSON(REPORTS_FILE, {}); }
function saveReports(d) { writeJSON(REPORTS_FILE, d); }
function getMembers() { return readJSON(MEMBERS_FILE, null); }
function saveMembers(m) { writeJSON(MEMBERS_FILE, m); }
function getConfig() {
  return Object.assign(
    { webhook: '', secret: '', atMobiles: [], checkTime: '18:00', siteUrl: '' },
    readJSON(CONFIG_FILE, {})
  );
}
function saveConfig(c) { writeJSON(CONFIG_FILE, c); }

function pad(n) { return String(n).padStart(2, '0'); }
function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
}

/* ====== 钉钉签名 ====== */
function buildSignedUrl(webhook, secret) {
  const timestamp = Date.now();
  const stringToSign = `${timestamp}\n${secret}`;
  const hmac = crypto.createHmac('sha256', secret).update(stringToSign).digest('base64');
  const sign = encodeURIComponent(hmac);
  const sep = webhook.indexOf('?') >= 0 ? '&' : '?';
  return `${webhook}${sep}timestamp=${timestamp}&sign=${sign}`;
}

function postJson(urlStr, bodyObj) {
  return new Promise((resolve) => {
    const body = JSON.stringify(bodyObj);
    const u = new URL(urlStr);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ ok: res.statusCode === 200, status: res.statusCode, body: data }));
    });
    req.on('error', e => resolve({ ok: false, error: e.message }));
    req.write(body);
    req.end();
  });
}

async function sendDingTalk(markdown, atMobiles) {
  const config = getConfig();
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
  // 钉钉返回 { errcode: 0, errmsg: 'ok' } 表示成功
  if (parsed.errcode === 0) return { ok: true, response: parsed };
  if (r.ok && parsed.errcode === undefined) return { ok: true, response: parsed };
  return { ok: false, error: parsed.errmsg || `HTTP ${r.status}`, response: parsed };
}

/* ====== 检查未填写并通知 ====== */
function findUnfilled(dateStr) {
  const reports = getReports();
  const members = getMembers() || [];
  const dayData = reports[dateStr] || {};
  return members.filter(m => {
    const rec = dayData[m];
    return !rec || !(rec.work || '').trim();
  });
}

async function checkAndNotify(dateStr) {
  const config = getConfig();
  const unfilled = findUnfilled(dateStr);
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
  // @ 手机号：使用配置中的全部手机号（@ 这些人）
  const atMobiles = (config.atMobiles || []).filter(Boolean);
  const r = await sendDingTalk(markdown, atMobiles);
  return { ...r, unfilled, sent: true };
}

/* ====== 定时检查 ====== */
let lastAutoCheckDate = null;
function startScheduler() {
  const config = getConfig();
  const checkTime = config.checkTime || process.env.CHECK_TIME || '18:00';
  const [targetH, targetM] = checkTime.split(':').map(Number);
  console.log(`[调度] 自动检查时间: ${checkTime}`);
  setInterval(() => {
    const now = new Date();
    const today = `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}`;
    if (lastAutoCheckDate === today) return;
    if (now.getHours() === targetH && now.getMinutes() >= targetM) {
      lastAutoCheckDate = today;
      console.log(`[${new Date().toISOString()}] 触发自动检查: ${today}`);
      checkAndNotify(today).then(r => {
        if (r.ok && r.sent) {
          console.log(`  -> 已推送，未填写 ${r.unfilled.length} 人: ${r.unfilled.join('、')}`);
        } else if (r.ok && !r.sent) {
          console.log(`  -> ${r.message}`);
        } else {
          console.error(`  -> 推送失败: ${r.error || JSON.stringify(r)}`);
        }
      }).catch(e => console.error('自动检查异常:', e));
    }
  }, 60 * 1000);
}

/* ====== HTTP 路由 ====== */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => resolve(body));
  });
}

const server = http.createServer(async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const u = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = u.pathname;
  const query = Object.fromEntries(u.searchParams.entries());

  try {
    // === API ===
    if (pathname === '/api/members' && req.method === 'GET') {
      return sendJson(res, 200, getMembers() || []);
    }
    if (pathname === '/api/members' && req.method === 'POST') {
      const body = await readBody(req);
      const arr = JSON.parse(body);
      if (!Array.isArray(arr)) return sendJson(res, 400, { error: 'members must be array' });
      saveMembers(arr);
      return sendJson(res, 200, { ok: true });
    }
    if (pathname === '/api/day' && req.method === 'GET') {
      const date = query.date;
      if (!date) return sendJson(res, 400, { error: 'missing date' });
      const reports = getReports();
      return sendJson(res, 200, reports[date] || {});
    }
    if (pathname === '/api/save-day' && req.method === 'POST') {
      const body = await readBody(req);
      const { date, data } = JSON.parse(body);
      if (!date) return sendJson(res, 400, { error: 'missing date' });
      const reports = getReports();
      reports[date] = data || {};
      saveReports(reports);
      return sendJson(res, 200, { ok: true });
    }
    if (pathname === '/api/config' && req.method === 'GET') {
      return sendJson(res, 200, getConfig());
    }
    if (pathname === '/api/config' && req.method === 'POST') {
      const body = await readBody(req);
      const cfg = JSON.parse(body);
      saveConfig(Object.assign(getConfig(), cfg));
      return sendJson(res, 200, { ok: true });
    }
    if (pathname === '/api/notify' && req.method === 'POST') {
      const date = query.date || todayStr();
      const r = await checkAndNotify(date);
      return sendJson(res, 200, r);
    }
    if (pathname === '/api/test' && req.method === 'POST') {
      const config = getConfig();
      if (!config.webhook) return sendJson(res, 400, { ok: false, error: '未配置 Webhook' });
      const markdown = {
        title: '日报系统测试',
        text: `## ✅ 测试消息\n\n这是一条来自团队日报系统的测试消息。\n\n时间：${new Date().toLocaleString('zh-CN')}\n\n如果收到这条消息，说明钉钉机器人配置正确。`
      };
      const r = await sendDingTalk(markdown, config.atMobiles || []);
      return sendJson(res, r.ok ? 200 : 400, r);
    }

    // === 未匹配的 /api/* 路径：返回 JSON 404，避免前端拿到 HTML 报错 ===
    if (pathname.startsWith('/api/')) {
      return sendJson(res, 404, { ok: false, error: `未知 API: ${req.method} ${pathname}` });
    }

    // === 静态文件 ===
    let filePath = pathname === '/' ? '/daily-report.html' : decodeURIComponent(pathname);
    // 防止目录穿越
    filePath = path.normalize(path.join(ROOT, filePath));
    if (!filePath.startsWith(ROOT)) {
      res.writeHead(403); res.end('Forbidden'); return;
    }
    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Not Found');
        return;
      }
      const ext = path.extname(filePath).toLowerCase();
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
      res.end(data);
    });
  } catch (e) {
    console.error('请求处理异常:', e);
    sendJson(res, 500, { ok: false, error: e.message });
  }
});

server.listen(PORT, () => {
  console.log('==========================================');
  console.log('  团队日报系统已启动');
  console.log(`  访问地址: http://localhost:${PORT}`);
  console.log(`  自动检查: ${getConfig().checkTime} 每日`);
  console.log('  钉钉配置: 在网页 "⚙️ 钉钉机器人设置" 中填写');
  console.log('==========================================');
  startScheduler();
});
