/**
 * Vercel Node.js 入口（最小化版本）
 *
 * Vercel 检测到 package.json 有 Node 依赖时，强制要求一个 server 入口
 * 文件（index.js / server.js 等），否则报 "No entrypoint found"。
 *
 * 本文件只负责路由分发：
 *   - /api/* → 转发到 api/*.js 函数
 *   - 其他路径 → 让 vercel.json 的 rewrites 处理（指向 index.html）
 *
 * 注意：Vercel 把本文件编译进函数目录后，__dirname 不再是项目根，
 * 静态文件由 vercel.json 的 rewrites 负责路由，本文件不直接读静态文件。
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
  '.css':  'text/css; charset=utf-8',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.svg':  'image/svg+xml'
};

// 静态文件候选根目录（Vercel 函数目录的各层父级）
function staticRoots() {
  const roots = [
    __dirname,
    process.cwd(),
    path.join(__dirname, '..'),
    path.join(__dirname, '..', '..'),
    path.join(process.cwd(), 'public'),
    path.join(__dirname, '..', 'public')
  ];
  return roots.filter((p, i, arr) => p && arr.indexOf(p) === i);
}

function findStaticFile(relPath) {
  const clean = relPath.replace(/^\/+/, '');
  for (const root of staticRoots()) {
    const full = path.normalize(path.join(root, clean));
    try {
      if (fs.existsSync(full) && fs.statSync(full).isFile()) {
        return full;
      }
    } catch {}
  }
  return null;
}

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

  // 静态文件：在多个候选根目录中查找
  const relPath = pathname === '/' ? '/index.html' : decodeURIComponent(pathname);
  const filePath = findStaticFile(relPath);
  if (filePath) {
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
    return;
  }

  // 找不到静态文件：返回内嵌的 fallback 页面
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><meta charset="utf-8"><title>团队日报</title>
<h1>团队日报系统</h1>
<p>静态文件 ${pathname} 未找到，但 API 已就绪。</p>
<p>访问 <a href="/api/stats">/api/stats</a> 查看数据库统计。</p>
<p>调试: __dirname=${__dirname}, cwd=${process.cwd()}</p>`);
});

const PORT = process.env.PORT || 3000;
if (require.main === module) {
  server.listen(PORT, () => {
    const dbUrl = lib.dbConfig().url || '(未配置)';
    console.log(`[index.js] listening on ${PORT}, db=${dbUrl}`);
  });
}

module.exports = server;
