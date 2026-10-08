const lib = require('./_lib');

module.exports = lib.wrapHandler(async (req, res) => {
  if (req.method === 'GET') {
    if (!lib.dbAvailable()) return lib.jsonRes(res, 503, { error: '数据库未配置' });
    const date = req.query?.date || new URL(req.url, 'http://x').searchParams.get('date');
    if (!date) return lib.jsonRes(res, 400, { error: 'missing date' });
    return lib.jsonRes(res, 200, await lib.getDay(date));
  }
  return lib.jsonRes(res, 405, { error: 'Method not allowed' });
});
