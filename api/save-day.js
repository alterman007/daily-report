const lib = require('./_lib');

module.exports = lib.wrapHandler(async (req, res) => {
  if (req.method === 'POST') {
    if (!lib.dbAvailable()) return lib.jsonRes(res, 503, { error: '数据库未配置（请设置 TURSO_DATABASE_URL / TURSO_AUTH_TOKEN 环境变量）' });
    const { date, data } = await lib.parseJsonBody(req);
    if (!date) return lib.jsonRes(res, 400, { error: 'missing date' });
    await lib.saveDay(date, data || {});
    return lib.jsonRes(res, 200, { ok: true });
  }
  return lib.jsonRes(res, 405, { error: 'Method not allowed' });
});
