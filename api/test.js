const lib = require('./_lib');

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return lib.jsonRes(res, 204, '');
  if (req.method === 'POST') {
    if (!lib.redisAvailable()) return lib.jsonRes(res, 503, { error: 'Redis 未配置' });
    const config = await lib.getConfig();
    if (!config.webhook) return lib.jsonRes(res, 400, { ok: false, error: '未配置 Webhook' });
    const markdown = {
      title: '日报系统测试',
      text: `## ✅ 测试消息\n\n这是一条来自团队日报系统的测试消息。\n\n时间：${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}\n\n如果收到这条消息，说明钉钉机器人配置正确。`
    };
    const r = await lib.sendDingTalk(markdown, config.atMobiles || []);
    return lib.jsonRes(res, r.ok ? 200 : 400, r);
  }
  return lib.jsonRes(res, 405, { error: 'Method not allowed' });
};
