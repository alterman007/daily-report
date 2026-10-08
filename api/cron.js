const lib = require('./_lib');

/**
 * Vercel Cron 自动检查
 *
 * 部署后用 Vercel Cron 每 10 分钟触发一次（见 vercel.json）。
 * 函数内部判断：
 *   1. 必须是工作日（周一~周五）
 *   2. 当前上海时区时间已过 checkTime（HH:MM）
 *   3. 当天还没推送过（用 Redis key daily:cron-sent 记录）
 * 满足条件则调用 checkAndNotify 推送到钉钉。
 */

module.exports = async (req, res) => {
  // 鉴权：Vercel cron 会带 x-vercel-cron-auth header
  const authHeader = req.headers['x-vercel-cron-auth'] || '';
  if (process.env.CRON_SECRET && authHeader !== process.env.CRON_SECRET) {
    return lib.jsonRes(res, 401, { ok: false, error: 'unauthorized' });
  }

  if (!lib.redisAvailable()) {
    return lib.jsonRes(res, 503, { ok: false, error: 'Redis 未配置' });
  }

  const now = lib.shanghaiNow();
  const config = await lib.getConfig();
  const checkTime = config.checkTime || '18:00';
  const [targetH, targetM] = checkTime.split(':').map(n => parseInt(n, 10));

  // 周末不检查（0=周日, 6=周六）
  // shanghaiNow.weekday 是英文 'Sun','Mon' 等，简化：直接看 Date.getUTCDay + 时区偏移
  const wd = new Date().getUTCDay();
  // 上海时区 UTC+8，把 UTC 时间转上海日期的 weekday
  // 简化：用 shanghaiNow 提供的 weekday 字符串
  const weekdayStr = now.weekday;
  const isWeekend = /^Sat|Sun$/.test(weekdayStr);
  if (isWeekend) {
    return lib.jsonRes(res, 200, { ok: true, skipped: true, reason: '周末不检查', now });
  }

  // 当前小时:分钟 必须 >= checkTime 才触发
  const curMin = now.hour * 60 + now.minute;
  const targetMin = targetH * 60 + targetM;
  if (curMin < targetMin) {
    return lib.jsonRes(res, 200, { ok: true, skipped: true, reason: `未到检查时间 ${checkTime}`, now });
  }

  // 检查今日是否已推送
  const today = now.date;
  const sent = await lib.getCronSent();
  if (sent[today]) {
    return lib.jsonRes(res, 200, { ok: true, skipped: true, reason: '今日已推送', now });
  }

  // 触发推送
  const r = await lib.checkAndNotify(today);
  if (r.ok) {
    sent[today] = { time: new Date().toISOString(), unfilled: r.unfilled || [] };
    await lib.saveCronSent(sent);
  }
  return lib.jsonRes(res, 200, { ...r, now, checkTime });
};
