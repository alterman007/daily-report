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

function createStore() {
  const file = resolveDbPath();
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
      sort_order INTEGER NOT NULL DEFAULT 0
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
    const del = db.prepare('DELETE FROM reports WHERE date = ?');
    const ins = db.prepare(
      'INSERT INTO reports (date, member, work, plan, updated_at) VALUES (?, ?, ?, ?, ?)'
    );
    const now = new Date().toISOString();
    transaction(() => {
      del.run(date);
      for (const [member, rec] of Object.entries(dayData || {})) {
        const name = String(member || '').trim();
        if (!name) continue;
        ins.run(date, name, (rec && rec.work) || '', (rec && rec.plan) || '', now);
      }
    });
    return true;
  }

  function getMembers() {
    return db.prepare(
      'SELECT name FROM members ORDER BY sort_order ASC, created_at ASC, name ASC'
    ).all().map((row) => String(row.name));
  }

  function saveMembers(members) {
    const seen = new Set();
    const names = [];
    for (const raw of members || []) {
      const name = String(raw || '').trim();
      if (!name || seen.has(name)) continue;
      seen.add(name);
      names.push(name);
    }
    const del = db.prepare('DELETE FROM members');
    const ins = db.prepare(
      'INSERT INTO members (name, created_at, sort_order) VALUES (?, ?, ?)'
    );
    const now = new Date().toISOString();
    transaction(() => {
      del.run();
      names.forEach((name, index) => ins.run(name, now, index));
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
    getMembers,
    saveMembers,
    getConfig,
    saveConfig,
    getCronSent,
    markCronSent,
    getStats
  };
}

module.exports = { createStore, DEFAULT_MEMBERS, DEFAULT_CONFIG };
