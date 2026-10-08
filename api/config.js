const lib = require('./_lib');

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return lib.jsonRes(res, 204, '');
  if (req.method === 'GET') {
    return lib.jsonRes(res, 200, await lib.getConfig());
  }
  if (req.method === 'POST') {
    if (!lib.redisAvailable()) return lib.jsonRes(res, 503, { error: 'Redis 未配置' });
    const cfg = await lib.parseJsonBody(req);
    await lib.saveConfig(Object.assign(await lib.getConfig(), cfg));
    return lib.jsonRes(res, 200, { ok: true });
  }
  return lib.jsonRes(res, 405, { error: 'Method not allowed' });
};
