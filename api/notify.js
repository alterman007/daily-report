const lib = require('./_lib');

module.exports = lib.wrapHandler(async (req, res) => {
  if (req.method === 'POST') {
    if (!lib.dbAvailable()) return lib.jsonRes(res, 503, { error: '数据库未配置' });
    const date = new URL(req.url, 'http://x').searchParams.get('date') || lib.shanghaiDateStr();
    const r = await lib.checkAndNotify(date);
    return lib.jsonRes(res, 200, r);
  }
  return lib.jsonRes(res, 405, { error: 'Method not allowed' });
});
