const lib = require('./_lib');

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return lib.jsonRes(res, 204, '');
  if (req.method === 'POST') {
    if (!lib.redisAvailable()) return lib.jsonRes(res, 503, { error: 'Redis 未配置' });
    const { date, data } = await lib.parseJsonBody(req);
    if (!date) return lib.jsonRes(res, 400, { error: 'missing date' });
    const reports = await lib.getReports();
    reports[date] = data || {};
    await lib.saveReports(reports);
    return lib.jsonRes(res, 200, { ok: true });
  }
  return lib.jsonRes(res, 405, { error: 'Method not allowed' });
};
