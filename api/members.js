const lib = require('./_lib');

module.exports = lib.wrapHandler(async (req, res) => {
  if (req.method === 'GET') {
    if (!lib.dbAvailable()) return lib.jsonRes(res, 503, { error: '数据库未配置（请设置 TURSO_DATABASE_URL / TURSO_AUTH_TOKEN 环境变量）' });
    return lib.jsonRes(res, 200, (await lib.getMembers()) || []);
  }
  if (req.method === 'POST') {
    const arr = await lib.parseJsonBody(req);
    if (!Array.isArray(arr)) return lib.jsonRes(res, 400, { error: 'members must be array' });
    await lib.saveMembers(arr);
    return lib.jsonRes(res, 200, { ok: true });
  }
  return lib.jsonRes(res, 405, { error: 'Method not allowed' });
});
