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

// Vercel 把 server.js 编译进函数目录后，__dirname 不一定是项目根
// 收集所有可能的静态文件根目录，按顺序查找
const STATIC_ROOTS = [
  __dirname,                              // 本地 node server.js
  process.cwd(),                          // Vercel serverless 常见工作目录
  path.join(__dirname, '..'),             // 函数目录的上一层
  path.join(process.cwd(), 'public'),     // public 约定
  path.join(__dirname, '..', 'public'),
  path.join(__dirname, '..', '..')        // 再上一层兜底
].filter((p, i, arr) => p && arr.indexOf(p) === i);

function findStaticFile(relPath) {
  // relPath 形如 "/index.html" 或 "/style.css"
  const clean = relPath.replace(/^\/+/, '');
  for (const root of STATIC_ROOTS) {
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
  if (!filePath) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
    return;
  }
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
