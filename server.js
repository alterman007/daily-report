/**
 * 本地启动入口（别名）
 *
 * 等价于 node local-dev.js —— 用 SQLite 内存数据库启动本地联调服务器
 *
 * 想连真实 Turso 数据库：
 *   TURSO_DATABASE_URL=libsql://xxx.turso.io \
 *     TURSO_AUTH_TOKEN=xxx node server.js
 *
 * 生产部署请用 Vercel + Turso，不需要这个文件。
 */
require('./local-dev.js');
