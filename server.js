/**
 * Vercel Node.js 入口（仅当仓库里存在 server.js 时被 Vercel 自动识别）
 *
 * 作用：把 /api/* 路由到 api/*.js，其余请求当作静态文件返回（index.html 等）
 * 生产环境用 Vercel + Turso，无需 :memory: 回退
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const lib = require('./api/_lib.js');

// 加载各 endpoint
const endpoints = {
  '/api/members':  require('./api/members.js'),
  '/api/day':      require('./api/day.js'),
  '/api/save-day': require('./api/save-day.js'),
  '/api/config':   require('./api/config.js'),
  '/api/notify':   require('./api/notify.js'),
  '/api/test':     require('./api/test.js'),
  '/api/cron':     require('./api/cron.js'),
  '/api/stats':    require('./api/stats.js')
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css':  'text/css; charset=utf-8'
};

// 包装 Node 原生 res 让它兼容 Vercel 风格的 res.status().json()
function wrapRes(res) {
  return {
    statusCode: 200,
    setHeader(k, v) { res.setHeader(k, v); return this; },
    status(code) { this.statusCode = code; return this; },
    json(obj) {
      const body = JSON.stringify(obj);
      if (!res.getHeader('Content-Type')) {
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
      }
      res.writeHead(this.statusCode);
      res.end(body);
      return this;
    },
    end(s) { res.end(s); return this; }
  };
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  req.query = Object.fromEntries(u.searchParams.entries());

  // 解析 JSON body
  if (req.method === 'POST' || req.method === 'PUT') {
    const raw = await new Promise(resolve => {
      let body = ''; req.on('data', c => body += c); req.on('end', () => resolve(body));
    });
    try { req.body = JSON.parse(raw); } catch { req.body = raw; }
  }

  const wrappedRes = wrapRes(res);

  // CORS
  lib.setCORS(wrappedRes);
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(''); return; }

  const pathname = u.pathname;
  if (pathname.startsWith('/api/')) {
    const handler = endpoints[pathname];
    if (handler) {
      try {
        return await handler(req, wrappedRes);
      } catch (e) {
        console.error(`[${pathname}] 错误:`, e);
        return lib.jsonRes(wrappedRes, 500, { ok: false, error: e.message });
      }
    }
    return lib.jsonRes(wrappedRes, 404, { ok: false, error: `未知 API: ${pathname}` });
  }

  // 静态文件
  let filePath = pathname === '/' ? '/index.html' : decodeURIComponent(pathname);
  filePath = path.normalize(path.join(__dirname, filePath));
  if (!filePath.startsWith(__dirname)) { res.writeHead(403); res.end('Forbidden'); return; }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

// Vercel 会注入 PORT 环境变量
const PORT = process.env.PORT || 3000;
if (require.main === module) {
  server.listen(PORT, () => {
    const dbUrl = lib.dbConfig().url || '(未配置)';
    console.log(`[server.js] listening on ${PORT}, db=${dbUrl}`);
  });
}

module.exports = server;
