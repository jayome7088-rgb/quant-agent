// SQLite-backed analysis history for the web server.
import Database from 'better-sqlite3';
import { dexterPath } from '../utils/paths.js';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const DB_PATH = dexterPath('history.db');

let db: Database.Database | null = null;

function getDb(): Database.Database {
  if (!db) {
    const dir = dirname(DB_PATH);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.exec(`
      CREATE TABLE IF NOT EXISTS analyses (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ticker TEXT NOT NULL,
        interval TEXT NOT NULL DEFAULT '5m',
        result TEXT NOT NULL,
        summary TEXT DEFAULT '',
        created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
      );
      CREATE INDEX IF NOT EXISTS idx_analyses_ticker ON analyses(ticker);
      CREATE INDEX IF NOT EXISTS idx_analyses_created ON analyses(created_at DESC);
    `);
  }
  return db;
}

export interface HistoryEntry {
  id: number;
  ticker: string;
  interval: string;
  result: string;
  summary: string;
  created_at: string;
}

export interface HistoryListResult {
  entries: HistoryEntry[];
  total: number;
}

export function insertAnalysis(ticker: string, interval: string, result: string): HistoryEntry {
  const d = getDb();
  const summary = extractSummary(result);
  const stmt = d.prepare(
    'INSERT INTO analyses (ticker, interval, result, summary) VALUES (?, ?, ?, ?)',
  );
  const info = stmt.run(ticker, interval, result, summary);
  const row = d.prepare('SELECT * FROM analyses WHERE id = ?').get(info.lastInsertRowid) as HistoryEntry;
  return row;
}

export function listAnalyses(opts: {
  search?: string;
  sort?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
} = {}): HistoryListResult {
  const d = getDb();
  const { search, sort = 'desc', limit = 50, offset = 0 } = opts;

  let where = '';
  const params: unknown[] = [];
  if (search) {
    where = 'WHERE ticker LIKE ?';
    params.push(`%${search.toUpperCase()}%`);
  }

  const countRow = d.prepare(`SELECT COUNT(*) as total FROM analyses ${where}`).get(...params) as { total: number };
  const rows = d.prepare(
    `SELECT * FROM analyses ${where} ORDER BY created_at ${sort === 'asc' ? 'ASC' : 'DESC'} LIMIT ? OFFSET ?`,
  ).all(...params, limit, offset) as HistoryEntry[];

  return { entries: rows, total: countRow.total };
}

export function getAnalysis(id: number): HistoryEntry | null {
  const d = getDb();
  const row = d.prepare('SELECT * FROM analyses WHERE id = ?').get(id) as HistoryEntry | undefined;
  return row ?? null;
}

export function deleteAnalysis(id: number): boolean {
  const d = getDb();
  const info = d.prepare('DELETE FROM analyses WHERE id = ?').run(id);
  return info.changes > 0;
}

function extractSummary(result: string): string {
  // Grab first meaningful line — typically the ticker + price line
  const lines = result.split('\n').filter(l => l.trim());
  for (const line of lines) {
    const cleaned = line.replace(/[═\*#]/g, '').trim();
    if (cleaned && cleaned.length > 5 && !cleaned.startsWith('⚠')) {
      return cleaned.slice(0, 200);
    }
  }
  return result.slice(0, 200);
}
