/**
 * 本地联调服务器：把 api/*.js 跑起来，用 SQLite 内存数据库（@libsql/client :memory:）
 * 仅用于本地测试，生产环境部署到 Vercel + Turso
 *
 * 用法：
 *   node local-dev.js                # 默认端口 3001，用 SQLite 内存数据库
 *   PORT=4000 node local-dev.js      # 改端口
 *   TURSO_DATABASE_URL=libsql://xxx.turso.io \
 *     TURSO_AUTH_TOKEN=xxx node local-dev.js   # 连真实 Turso
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

// 默认启用 SQLite 内存模式（重启进程数据会丢）
// 如果已设置 TURSO_DATABASE_URL 则用真实 Turso
if (!process.env.TURSO_DATABASE_URL && !process.env.LIBSQL_URL) {
  process.env.LIBSQL_URL = ':memory:';
}

const lib = require('./api/_lib.js');

// 加载各 endpoint
const endpoints = {
  '/api/members': require('./api/members.js'),
  '/api/day':     require('./api/day.js'),
  '/api/save-day':require('./api/save-day.js'),
  '/api/config':  require('./api/config.js'),
  '/api/notify':  require('./api/notify.js'),
  '/api/test':    require('./api/test.js'),
  '/api/cron':    require('./api/cron.js')
};

const MIME = {
  '.html':'text/html; charset=utf-8','.js':'application/javascript; charset=utf-8',
  '.json':'application/json; charset=utf-8','.css':'text/css; charset=utf-8'
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
    if (err) { res.writeHead(404, {'Content-Type':'text/plain; charset=utf-8'}); res.end('Not Found'); return; }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  const usingTurso = lib.dbConfig().url && !lib.dbConfig().url.startsWith(':memory:');
  console.log('============================================');
  console.log(`  本地联调服务器已启动 (${usingTurso ? 'Turso 远程' : 'SQLite 内存数据库'})`);
  console.log(`  访问: http://localhost:${PORT}`);
  console.log(`  数据库: ${lib.dbConfig().url || '(未配置)'}`);
  console.log('  注意：内存模式重启进程数据会丢。生产用 Vercel + Turso');
  console.log('============================================');
});
