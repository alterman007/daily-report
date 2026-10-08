const lib = require('./_lib');

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return lib.jsonRes(res, 204, '');
  if (req.method === 'GET') {
    if (!lib.redisAvailable()) return lib.jsonRes(res, 503, { error: 'Redis 未配置（请设置 KV_REST_API_URL / KV_REST_API_TOKEN 环境变量）' });
    return lib.jsonRes(res, 200, (await lib.getMembers()) || []);
  }
  if (req.method === 'POST') {
    const arr = await lib.parseJsonBody(req);
    if (!Array.isArray(arr)) return lib.jsonRes(res, 400, { error: 'members must be array' });
    await lib.saveMembers(arr);
    return lib.jsonRes(res, 200, { ok: true });
  }
  return lib.jsonRes(res, 405, { error: 'Method not allowed' });
};
