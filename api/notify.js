const lib = require('./_lib');

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return lib.jsonRes(res, 204, '');
  if (req.method === 'POST') {
    if (!lib.redisAvailable()) return lib.jsonRes(res, 503, { error: 'Redis 未配置' });
    const date = new URL(req.url, 'http://x').searchParams.get('date') || lib.shanghaiDateStr();
    const r = await lib.checkAndNotify(date);
    return lib.jsonRes(res, 200, r);
  }
  return lib.jsonRes(res, 405, { error: 'Method not allowed' });
};
