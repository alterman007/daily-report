const lib = require('./_lib');

/**
 * 数据库存储统计
 * GET /api/stats
 *
 * 返回 SQLite 数据库里实际存储的统计信息，方便验证数据确实持久化到云端
 */
module.exports = lib.wrapHandler(async (req, res) => {
  if (req.method !== 'GET') {
    return lib.jsonRes(res, 405, { error: 'Method not allowed' });
  }
  if (!lib.dbAvailable()) {
    return lib.jsonRes(res, 503, { error: '数据库未配置' });
  }

  await lib.initOnce();
  const db = lib.getDb();
  if (!db) {
    return lib.jsonRes(res, 503, { error: '数据库连接失败' });
  }

  // 成员总数
  const membersRs = await db.execute('SELECT COUNT(*) AS n FROM members');
  const memberCount = Number(membersRs.rows[0].n || 0);

  // 日报记录总数（每天每人算 1 条）
  const reportsRs = await db.execute('SELECT COUNT(*) AS n FROM reports');
  const reportCount = Number(reportsRs.rows[0].n || 0);

  // 涉及到的日期数
  const datesRs = await db.execute('SELECT COUNT(DISTINCT date) AS n FROM reports');
  const dateCount = Number(datesRs.rows[0].n || 0);

  // 最近 5 条日报记录
  const recentRs = await db.execute(
    'SELECT date, member, work, plan, updated_at FROM reports ORDER BY updated_at DESC LIMIT 5'
  );
  const recent = recentRs.rows.map(r => ({
    date: String(r.date),
    member: String(r.member),
    work: String(r.work || ''),
    plan: String(r.plan || ''),
    updatedAt: String(r.updated_at || '')
  }));

  // cron 推送记录数
  let cronCount = 0;
  try {
    const cronRs = await db.execute('SELECT COUNT(*) AS n FROM cron_sent');
    cronCount = Number(cronRs.rows[0].n || 0);
  } catch {}

  // 钉钉配置（隐藏敏感字段，仅显示是否已配置）
  const config = await lib.getConfig();
  const configStatus = {
    webhookConfigured: !!config.webhook,
    secretConfigured: !!config.secret,
    atMobilesCount: (config.atMobiles || []).length,
    checkTime: config.checkTime,
    siteUrl: config.siteUrl ? '(已配置)' : '(未配置)'
  };

  return lib.jsonRes(res, 200, {
    ok: true,
    storage: 'SQLite (Turso libSQL)',
    databaseUrl: lib.dbConfig().url ? lib.dbConfig().url.replace(/:[^:@]+@/, ':***@') : '(未配置)',
    stats: {
      memberCount,
      reportCount,
      dateCount,
      cronSentCount: cronCount
    },
    dingtalkConfig: configStatus,
    recentReports: recent,
    serverTime: new Date().toISOString(),
    shanghaiTime: lib.shanghaiNow()
  });
});
