const lib = require('./_lib');

/**
 * Vercel Cron 自动检查
 *
 * vercel.json 配置：工作日（周一~周五）每天 UTC 13:30 触发（= 北京时间 21:30）。
 *
 * 函数内部判断：
 *   1. 必须是工作日（周一~周五，cron schedule 已限定，这里双重保险）
 *   2. 当天还没推送过（查 cron_sent 表）
 * 满足条件则调用 checkAndNotify 推送到钉钉。
 */

module.exports = lib.wrapHandler(async (req, res) => {
  // 鉴权：Vercel cron 会带 x-vercel-cron-auth header
  const authHeader = req.headers['x-vercel-cron-auth'] || '';
  if (process.env.CRON_SECRET && authHeader !== process.env.CRON_SECRET) {
    return lib.jsonRes(res, 401, { ok: false, error: 'unauthorized' });
  }

  if (!lib.dbAvailable()) {
    return lib.jsonRes(res, 503, { ok: false, error: '数据库未配置' });
  }

  const now = lib.shanghaiNow();
  const config = await lib.getConfig();
  const checkTime = config.checkTime || '21:30';

  // 周末不检查
  const weekdayStr = now.weekday;
  const isWeekend = /^Sat|Sun$/.test(weekdayStr);
  if (isWeekend) {
    return lib.jsonRes(res, 200, { ok: true, skipped: true, reason: '周末不检查', now });
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
    await lib.markCronSent(today, {
      time: new Date().toISOString(),
      unfilled: r.unfilled || []
    });
  }
  return lib.jsonRes(res, 200, { ...r, now, checkTime });
});
