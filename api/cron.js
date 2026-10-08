const lib = require('./_lib');

/**
 * Vercel Cron 自动检查
 *
 * vercel.json 配置：工作日（周一~周五）每天 UTC 13:30 触发（= 北京时间 21:30）。
 *
 * 函数内部判断：
 *   1. 必须是工作日（周一~周五，cron schedule 已限定，这里双重保险）
 *   2. 当天还没推送过（用 Redis key daily:cron-sent 记录）
 * 满足条件则调用 checkAndNotify 推送到钉钉。
 *
 * 注意：cron 触发 = 推送，不再做"当前时间 vs checkTime"比较，
 * 因为 Hobby 一天只触发一次，跳过就再也不推了。
 * 想改推送时间，改 vercel.json 的 schedule（注意是 UTC 时间，减 8 得北京时间）。
 * checkTime 字段保留供网页端"立即通知"等场景使用，cron 端不再依赖它做时间窗。
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
    sent[today] = { time: new Date().toISOString(), unfilled: r.unfilled || [] };
    await lib.saveCronSent(sent);
  }
  return lib.jsonRes(res, 200, { ...r, now, checkTime });
};

