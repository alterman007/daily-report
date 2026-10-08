'use strict';

const emitWarning = process.emitWarning;
process.emitWarning = function (warning, type, code, ctor) {
  const name = typeof warning === 'string' ? type : warning && warning.name;
  const message = typeof warning === 'string' ? warning : warning && warning.message;
  if (name === 'ExperimentalWarning' && /sqlite/i.test(String(message || ''))) return;
  return emitWarning.call(process, warning, type, code, ctor);
};

const path = require('path');
const express = require('express');
const { createStore } = require('./lib/db');
const { createNotifier, shanghaiNow } = require('./lib/dingtalk');

const PORT = Number(process.env.PORT || 3000);
const store = createStore();
const notifier = createNotifier(store);
const app = express();

app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-cron-secret, x-vercel-cron-auth');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

function isDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function cronAuthorized(req) {
  const secret = process.env.CRON_SECRET || '';
  if (!secret) return true;
  const header = req.get('x-cron-secret') || req.get('x-vercel-cron-auth') || '';
  return header === secret || req.query.secret === secret;
}

app.get('/api/members', (_req, res) => {
  res.json(store.getMembers());
});

app.post('/api/members', (req, res) => {
  if (!Array.isArray(req.body)) {
    return res.status(400).json({ error: 'members must be array' });
  }
  store.saveMembers(req.body);
  res.json({ ok: true });
});

app.post('/api/rename-member', (req, res) => {
  const from = req.body && req.body.from;
  const to = req.body && req.body.to;
  const result = store.renameMember(from, to);
  if (!result.ok) return res.status(400).json(result);
  res.json(result);
});

app.get('/api/day', (req, res) => {
  const date = req.query.date;
  if (!isDate(date)) return res.status(400).json({ error: 'missing date' });
  res.json(store.getDay(date));
});

app.get('/api/reports', (_req, res) => {
  res.json(store.getReports());
});

app.post('/api/save-day', (req, res) => {
  const date = req.body && req.body.date;
  const data = (req.body && req.body.data) || {};
  if (!isDate(date)) return res.status(400).json({ error: 'missing date' });
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return res.status(400).json({ error: 'data must be object' });
  }
  store.saveDay(date, data);
  res.json({ ok: true });
});

app.get('/api/config', (_req, res) => {
  res.json(store.getConfig());
});

app.post('/api/config', (req, res) => {
  const cfg = req.body && typeof req.body === 'object' ? req.body : {};
  const current = store.getConfig();
  const atMobiles = cfg.atMobiles !== undefined ? cfg.atMobiles : current.atMobiles;
  store.saveConfig({
    webhook: cfg.webhook !== undefined ? String(cfg.webhook) : current.webhook,
    secret: cfg.secret !== undefined ? String(cfg.secret) : current.secret,
    atMobiles: Array.isArray(atMobiles) ? atMobiles : [],
    checkTime: cfg.checkTime !== undefined ? String(cfg.checkTime) : current.checkTime,
    siteUrl: cfg.siteUrl !== undefined ? String(cfg.siteUrl) : current.siteUrl
  });
  res.json({ ok: true });
});

app.post('/api/notify', async (req, res) => {
  const date = isDate(req.query.date) ? req.query.date : shanghaiNow().date;
  const result = await notifier.checkAndNotify(date);
  res.json(result);
});

app.post('/api/test', async (_req, res) => {
  const config = store.getConfig();
  if (!config.webhook) return res.status(400).json({ ok: false, error: '未配置 Webhook' });
  const markdown = {
    title: '日报系统测试',
    text: `## ✅ 测试消息\n\n这是一条来自团队日报系统的测试消息。\n\n时间：${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}\n\n如果收到这条消息，说明钉钉机器人配置正确。`
  };
  const result = await notifier.sendDingTalk(markdown, []);
  res.status(result.ok ? 200 : 400).json(result);
});

app.all('/api/cron', async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!cronAuthorized(req)) return res.status(401).json({ ok: false, error: 'unauthorized' });
  const result = await notifier.runScheduledCheck();
  res.json({ ok: true, ...(result || {}) });
});

app.get('/api/stats', (_req, res) => {
  const stats = store.getStats();
  const config = store.getConfig();
  res.json({
    ok: true,
    storage: 'SQLite',
    databaseUrl: store.file,
    stats: {
      memberCount: stats.memberCount,
      reportCount: stats.reportCount,
      dateCount: stats.dateCount,
      cronSentCount: stats.cronSentCount
    },
    dingtalkConfig: {
      webhookConfigured: !!config.webhook,
      secretConfigured: !!config.secret,
      atMobilesCount: (config.atMobiles || []).length,
      memberMobileCount: stats.mobileCount,
      checkTime: config.checkTime,
      siteUrl: config.siteUrl ? '(已配置)' : '(未配置)'
    },
    recentReports: stats.recent,
    serverTime: new Date().toISOString(),
    shanghaiTime: shanghaiNow()
  });
});

app.use('/api', (req, res) => {
  res.status(404).json({ ok: false, error: `未知 API: ${req.originalUrl.split('?')[0]}` });
});

app.use(express.static(path.join(__dirname, 'public')));

app.use((error, _req, res, _next) => {
  if (error && error.type === 'entity.parse.failed') {
    return res.status(400).json({ ok: false, error: 'invalid json' });
  }
  console.error(error);
  res.status(500).json({ ok: false, error: error.message || 'server error' });
});

function startScheduler() {
  const tick = () => {
    notifier.runScheduledCheck().then((result) => {
      if (result && result.sent) {
        const missing = (result.missingMobile || []).length;
        console.log(`[cron] 已推送 ${result.now && result.now.date} 未填写 ${(result.unfilled || []).length} 人，@ ${((result.atMobiles) || []).length} 人${missing ? `，${missing} 人未绑定手机号` : ''}`);
      } else if (result && result.ok === false && result.error !== '未配置钉钉 Webhook') {
        console.error('[cron] 推送失败:', result.error || 'unknown');
      }
    }).catch((error) => {
      console.error('[cron] 检查失败:', error.message);
    });
  };
  setTimeout(tick, 2000);
  setInterval(tick, 20000);
}

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`[daily-report] http://0.0.0.0:${PORT}`);
  console.log(`[daily-report] sqlite ${store.file}`);
  startScheduler();
});

function shutdown() {
  server.close(() => {
    try { store.close(); } catch (_) { /* ignore */ }
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

module.exports = app;
