'use strict';

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const DEFAULT_MEMBERS = [
  '曹二帅', '樊星名', '林喜纯', '刘飞燕', '曹东旭',
  '俞奇峰', '岳俊新', '马海波', '汪云涵', '蔡卓甫', '胡致远'
];

const DEFAULT_CONFIG = {
  webhook: '',
  secret: '',
  atMobiles: [],
  checkTime: '21:30',
  siteUrl: ''
};

function resolveDbPath() {
  return process.env.DATABASE_PATH || path.join(__dirname, '..', 'data', 'daily-report.db');
}

function readPasswdUser(name) {
  let text = '';
  try {
    text = fs.readFileSync('/etc/passwd', 'utf8');
  } catch (_) {
    return null;
  }
  const line = text.split('\n').find((row) => row.startsWith(`${name}:`));
  if (!line) return null;
  const parts = line.split(':');
  const uid = Number(parts[2]);
  const gid = Number(parts[3]);
  if (!Number.isInteger(uid) || !Number.isInteger(gid)) return null;
  return { uid, gid };
}

function migrateLegacyDatabase(destFile) {
  const legacy = process.env.LEGACY_DATABASE_PATH;
  if (!legacy || fs.existsSync(destFile)) return;
  const src = path.resolve(legacy);
  if (!fs.existsSync(src)) return;
  for (const suffix of ['', '-wal', '-shm']) {
    const from = src + suffix;
    if (!fs.existsSync(from)) continue;
    fs.copyFileSync(from, destFile + suffix);
  }
  console.log(`[daily-report] migrated sqlite to ${destFile}`);
}

function dropToNodeUser(dir, abs) {
  if (typeof process.getuid !== 'function' || process.getuid() !== 0) return;
  const ids = readPasswdUser('node');
  if (!ids) return;
  try {
    fs.chownSync(dir, ids.uid, ids.gid);
    for (const suffix of ['', '-wal', '-shm']) {
      const target = abs + suffix;
      if (fs.existsSync(target)) fs.chownSync(target, ids.uid, ids.gid);
    }
    process.setgid(ids.gid);
    process.setuid(ids.uid);
  } catch (error) {
    console.warn(`[daily-report] keep root, cannot drop privileges: ${error.message}`);
  }
}

// 先把旧数据卷里的库拷到宿主机目录，再打开数据库。升级镜像不会经过这一步删文件。
function prepareDataDirectory(file) {
  if (!file || file === ':memory:') return;
  const abs = path.resolve(file);
  const dir = path.dirname(abs);
  fs.mkdirSync(dir, { recursive: true });
  migrateLegacyDatabase(abs);
  dropToNodeUser(dir, abs);
}

function normalizeMobile(value) {
  let digits = String(value || '').replace(/\D/g, '');
  if (digits.startsWith('86') && digits.length === 13) digits = digits.slice(2);
  return /^1\d{10}$/.test(digits) ? digits : '';
}

function ensureColumn(db, table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (columns.some((col) => col.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

function createStore() {
  const file = resolveDbPath();
  prepareDataDirectory(file);
  let db;
  if (file === ':memory:') {
    db = new DatabaseSync(':memory:');
  } else {
    const abs = path.resolve(file);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    db = new DatabaseSync(abs);
  }

  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS reports (
      date TEXT NOT NULL,
      member TEXT NOT NULL,
      work TEXT,
      plan TEXT,
      updated_at TEXT,
      PRIMARY KEY (date, member)
    );
    CREATE TABLE IF NOT EXISTS members (
      name TEXT PRIMARY KEY,
      created_at TEXT,
      sort_order INTEGER NOT NULL DEFAULT 0,
      mobile TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS config (
      id INTEGER PRIMARY KEY,
      webhook TEXT,
      secret TEXT,
      at_mobiles TEXT,
      check_time TEXT,
      site_url TEXT
    );
    CREATE TABLE IF NOT EXISTS cron_sent (
      date TEXT PRIMARY KEY,
      time TEXT,
      unfilled TEXT
    );
  `);
  ensureColumn(db, 'members', 'mobile', "TEXT NOT NULL DEFAULT ''");

  const memberCount = db.prepare('SELECT COUNT(*) AS n FROM members').get();
  if (Number(memberCount.n) === 0) {
    const now = new Date().toISOString();
    const insert = db.prepare(
      'INSERT INTO members (name, created_at, sort_order) VALUES (?, ?, ?)'
    );
    transaction(() => {
      DEFAULT_MEMBERS.forEach((name, index) => insert.run(name, now, index));
    });
  }

  function transaction(fn) {
    db.exec('BEGIN');
    try {
      const result = fn();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch (_) { /* already closed */ }
      throw error;
    }
  }

  function getReports() {
    const rows = db.prepare('SELECT date, member, work, plan FROM reports').all();
    const out = {};
    for (const row of rows) {
      const date = String(row.date);
      if (!out[date]) out[date] = {};
      out[date][String(row.member)] = {
        work: String(row.work || ''),
        plan: String(row.plan || '')
      };
    }
    return out;
  }

  function getDay(date) {
    const rows = db.prepare(
      'SELECT member, work, plan FROM reports WHERE date = ?'
    ).all(date);
    const out = {};
    for (const row of rows) {
      out[String(row.member)] = {
        work: String(row.work || ''),
        plan: String(row.plan || '')
      };
    }
    return out;
  }

  function saveDay(date, dayData) {
    const entries = Object.entries(dayData || {}).filter(([member]) => String(member || '').trim());
    if (!entries.length) return true;
    const upsert = db.prepare(`
      INSERT INTO reports (date, member, work, plan, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(date, member) DO UPDATE SET
        work = excluded.work,
        plan = excluded.plan,
        updated_at = excluded.updated_at
    `);
    const now = new Date().toISOString();
    transaction(() => {
      for (const [member, rec] of entries) {
        const name = String(member).trim();
        upsert.run(date, name, (rec && rec.work) || '', (rec && rec.plan) || '', now);
      }
    });
    return true;
  }

  function renameMember(oldName, newName) {
    const from = String(oldName || '').trim();
    const to = String(newName || '').trim();
    if (!from || !to) return { ok: false, error: 'missing name' };
    if (from === to) return { ok: true, migrated: 0 };
    if (!db.prepare('SELECT 1 AS n FROM members WHERE name = ?').get(from)) {
      return { ok: false, error: 'member not found' };
    }
    if (db.prepare('SELECT 1 AS n FROM members WHERE name = ?').get(to)) {
      return { ok: false, error: 'name exists' };
    }
    if (db.prepare('SELECT 1 AS n FROM reports WHERE member = ? LIMIT 1').get(to)) {
      return { ok: false, error: 'name exists' };
    }
    let migrated = 0;
    transaction(() => {
      const updated = db.prepare('UPDATE reports SET member = ? WHERE member = ?').run(to, from);
      migrated = Number(updated.changes || 0);
      db.prepare('UPDATE members SET name = ? WHERE name = ?').run(to, from);
    });
    return { ok: true, migrated };
  }

  function getMembers() {
    return db.prepare(
      'SELECT name, mobile FROM members ORDER BY sort_order ASC, created_at ASC, name ASC'
    ).all().map((row) => ({
      name: String(row.name),
      mobile: String(row.mobile || '')
    }));
  }

  function saveMembers(members) {
    const previous = new Map(
      db.prepare('SELECT name, mobile FROM members').all().map((row) => [
        String(row.name),
        String(row.mobile || '')
      ])
    );
    const seen = new Set();
    const rows = [];
    for (const raw of members || []) {
      const parsed = typeof raw === 'string'
        ? { name: raw, mobile: undefined }
        : (raw && typeof raw === 'object' ? raw : {});
      const name = String(parsed.name || '').trim();
      if (!name || seen.has(name)) continue;
      seen.add(name);
      const mobile = parsed.mobile === undefined
        ? (previous.get(name) || '')
        : normalizeMobile(parsed.mobile);
      rows.push({ name, mobile });
    }
    const del = db.prepare('DELETE FROM members');
    const ins = db.prepare(
      'INSERT INTO members (name, created_at, sort_order, mobile) VALUES (?, ?, ?, ?)'
    );
    const now = new Date().toISOString();
    transaction(() => {
      del.run();
      rows.forEach((row, index) => ins.run(row.name, now, index, row.mobile));
    });
    return true;
  }

  function getConfig() {
    const row = db.prepare(
      'SELECT webhook, secret, at_mobiles, check_time, site_url FROM config WHERE id = 1'
    ).get();
    if (!row) return { ...DEFAULT_CONFIG, atMobiles: [] };
    let atMobiles = [];
    try { atMobiles = JSON.parse(String(row.at_mobiles || '[]')); } catch (_) { atMobiles = []; }
    if (!Array.isArray(atMobiles)) atMobiles = [];
    return {
      webhook: String(row.webhook || ''),
      secret: String(row.secret || ''),
      atMobiles,
      checkTime: String(row.check_time || DEFAULT_CONFIG.checkTime),
      siteUrl: String(row.site_url || '')
    };
  }

  function saveConfig(config) {
    const atMobiles = Array.isArray(config.atMobiles)
      ? config.atMobiles.map((item) => String(item).trim()).filter(Boolean)
      : [];
    db.prepare(`
      INSERT INTO config (id, webhook, secret, at_mobiles, check_time, site_url)
      VALUES (1, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        webhook = excluded.webhook,
        secret = excluded.secret,
        at_mobiles = excluded.at_mobiles,
        check_time = excluded.check_time,
        site_url = excluded.site_url
    `).run(
      config.webhook || '',
      config.secret || '',
      JSON.stringify(atMobiles),
      config.checkTime || DEFAULT_CONFIG.checkTime,
      config.siteUrl || ''
    );
    return true;
  }

  function getCronSent() {
    const rows = db.prepare('SELECT date, time, unfilled FROM cron_sent').all();
    const out = {};
    for (const row of rows) {
      let unfilled = [];
      try { unfilled = JSON.parse(String(row.unfilled || '[]')); } catch (_) { unfilled = []; }
      out[String(row.date)] = { time: String(row.time || ''), unfilled };
    }
    return out;
  }

  function markCronSent(date, value) {
    db.prepare(`
      INSERT INTO cron_sent (date, time, unfilled) VALUES (?, ?, ?)
      ON CONFLICT(date) DO UPDATE SET
        time = excluded.time,
        unfilled = excluded.unfilled
    `).run(
      date,
      (value && value.time) || new Date().toISOString(),
      JSON.stringify((value && value.unfilled) || [])
    );
    return true;
  }

  function getStats() {
    const memberCountRow = db.prepare('SELECT COUNT(*) AS n FROM members').get();
    const mobileCountRow = db.prepare(
      "SELECT COUNT(*) AS n FROM members WHERE mobile != ''"
    ).get();
    const reportCountRow = db.prepare('SELECT COUNT(*) AS n FROM reports').get();
    const dateCountRow = db.prepare('SELECT COUNT(DISTINCT date) AS n FROM reports').get();
    const cronCountRow = db.prepare('SELECT COUNT(*) AS n FROM cron_sent').get();
    const recent = db.prepare(`
      SELECT date, member, work, plan, updated_at
      FROM reports
      ORDER BY updated_at DESC
      LIMIT 5
    `).all().map((row) => ({
      date: String(row.date),
      member: String(row.member),
      work: String(row.work || ''),
      plan: String(row.plan || ''),
      updatedAt: String(row.updated_at || '')
    }));
    return {
      memberCount: Number(memberCountRow.n || 0),
      mobileCount: Number(mobileCountRow.n || 0),
      reportCount: Number(reportCountRow.n || 0),
      dateCount: Number(dateCountRow.n || 0),
      cronSentCount: Number(cronCountRow.n || 0),
      recent
    };
  }

  return {
    file: file === ':memory:' ? file : path.resolve(file),
    close() { db.close(); },
    getReports,
    getDay,
    saveDay,
    renameMember,
    getMembers,
    saveMembers,
    getConfig,
    saveConfig,
    getCronSent,
    markCronSent,
    getStats
  };
}

module.exports = { createStore, prepareDataDirectory, resolveDbPath, DEFAULT_MEMBERS, DEFAULT_CONFIG };
