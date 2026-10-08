const lib = require('./_lib');

module.exports = lib.wrapHandler(async (req, res) => {
  if (req.method === 'GET') {
    return lib.jsonRes(res, 200, await lib.getConfig());
  }
  if (req.method === 'POST') {
    if (!lib.dbAvailable()) return lib.jsonRes(res, 503, { error: '数据库未配置' });
    const cfg = await lib.parseJsonBody(req);
    await lib.saveConfig(Object.assign(await lib.getConfig(), cfg));
    return lib.jsonRes(res, 200, { ok: true });
  }
  return lib.jsonRes(res, 405, { error: 'Method not allowed' });
});
