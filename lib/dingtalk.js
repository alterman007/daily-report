'use strict';

const crypto = require('crypto');

function shanghaiNow(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
    hourCycle: 'h23'
  }).formatToParts(date);
  const get = (type) => parts.find((part) => part.type === type)?.value || '';
  let hour = parseInt(get('hour'), 10);
  if (hour === 24) hour = 0;
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    hour,
    minute: parseInt(get('minute'), 10),
    weekday: get('weekday')
  };
}

function parseCheckTime(value) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value || '').trim());
  if (!match) return { hour: 21, minute: 30 };
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return { hour: 21, minute: 30 };
  return { hour, minute };
}

function buildSignedUrl(webhook, secret) {
  const timestamp = Date.now();
  const stringToSign = `${timestamp}\n${secret}`;
  const hmac = crypto.createHmac('sha256', secret).update(stringToSign).digest('base64');
  const sign = encodeURIComponent(hmac);
  const sep = webhook.includes('?') ? '&' : '?';
  return `${webhook}${sep}timestamp=${timestamp}&sign=${sign}`;
}

async function postJson(url, body) {
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const text = await response.text();
    return { ok: response.ok, status: response.status, body: text };
  } catch (error) {
    return { ok: false, status: 0, body: '', error: error.message };
  }
}

function createNotifier(store) {
  let running = false;

  async function sendDingTalk(markdown, atMobiles) {
    const config = store.getConfig();
    if (!config.webhook) return { ok: false, error: '未配置钉钉 Webhook' };
    const fullUrl = config.secret
      ? buildSignedUrl(config.webhook, config.secret)
      : config.webhook;
    const payload = {
      msgtype: 'markdown',
      markdown,
      at: { atMobiles: atMobiles || [], isAtAll: false }
    };
    const response = await postJson(fullUrl, payload);
    let parsed = {};
    try { parsed = JSON.parse(response.body); } catch (_) { parsed = {}; }
    if (parsed.errcode === 0) return { ok: true, response: parsed };
    if (response.ok && parsed.errcode === undefined) return { ok: true, response: parsed };
    return {
      ok: false,
      error: parsed.errmsg || response.error || `HTTP ${response.status}`,
      response: parsed
    };
  }

  async function findUnfilled(dateStr) {
    const members = store.getMembers();
    const dayData = store.getDay(dateStr);
    return members.filter((name) => {
      const rec = dayData[name];
      return !rec || !(rec.work || '').trim();
    });
  }

  async function checkAndNotify(dateStr) {
    const config = store.getConfig();
    const unfilled = await findUnfilled(dateStr);
    if (unfilled.length === 0) {
      return { ok: true, sent: false, message: '全员已填写，无需通知', unfilled: [] };
    }
    const memberList = unfilled.map((name) => `- ${name}`).join('\n');
    const linkText = config.siteUrl ? `\n\n> **[前往填写日报](${config.siteUrl})**` : '';
    const markdown = {
      title: `日报未填写提醒 ${dateStr}`,
      text: `## 📋 日报未填写提醒\n\n**日期**：${dateStr}\n\n以下同事尚未填写今日日报，请尽快补上：\n\n${memberList}${linkText}\n\n— 自动检查来自团队日报系统`
    };
    const atMobiles = (config.atMobiles || []).filter(Boolean);
    const result = await sendDingTalk(markdown, atMobiles);
    return { ...result, unfilled, sent: true };
  }

  async function runScheduledCheck() {
    if (running) return null;
    running = true;
    try {
      const now = shanghaiNow();
      if (/^Sat|Sun$/.test(now.weekday)) return { skipped: true, reason: '周末不检查', now };
      const config = store.getConfig();
      const check = parseCheckTime(config.checkTime);
      const currentMinutes = now.hour * 60 + now.minute;
      const checkMinutes = check.hour * 60 + check.minute;
      if (currentMinutes < checkMinutes) {
        return { skipped: true, reason: '未到检查时间', now };
      }
      const sent = store.getCronSent();
      if (sent[now.date]) return { skipped: true, reason: '今日已推送', now };

      const result = await checkAndNotify(now.date);
      if (result.ok) {
        store.markCronSent(now.date, {
          time: new Date().toISOString(),
          unfilled: result.unfilled || []
        });
      }
      return { ...result, now, checkTime: config.checkTime || '21:30' };
    } finally {
      running = false;
    }
  }

  return { sendDingTalk, checkAndNotify, runScheduledCheck };
}

module.exports = { shanghaiNow, createNotifier, buildSignedUrl };
