const lib = require('./_lib');

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return lib.jsonRes(res, 204, '');
  if (req.method === 'GET') {
    if (!lib.redisAvailable()) return lib.jsonRes(res, 503, { error: 'Redis 未配置' });
    const date = req.query?.date || new URL(req.url, 'http://x').searchParams.get('date');
    if (!date) return lib.jsonRes(res, 400, { error: 'missing date' });
    const reports = await lib.getReports();
    return lib.jsonRes(res, 200, reports[date] || {});
  }
  return lib.jsonRes(res, 405, { error: 'Method not allowed' });
};
