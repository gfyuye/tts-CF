import fs from 'fs';
import path from 'path';

export class JsonD1 {
  constructor(filePath) {
    this.filePath = filePath;
    this.data = this._load();
  }

  _load() {
    try {
      if (fs.existsSync(this.filePath)) {
        return JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      }
    } catch (e) {
      console.warn('加载 db.json 失败，使用空库:', e.message);
    }
    return { endpoint_table: [], token_cache: [], voice_list: [] };
  }

  _save() {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2));
  }

  prepare(sql) {
    return new JsonStatement(this, sql);
  }

  async batch(statements) {
    const backup = JSON.parse(JSON.stringify(this.data));
    const results = [];
    try {
      for (const stmt of statements) {
        results.push(await stmt.run());
      }
      this._save();
      return results;
    } catch (e) {
      this.data = backup;
      throw e;
    }
  }
}

class JsonStatement {
  constructor(db, sql) {
    this.db = db;
    this.sql = sql.trim().replace(/\s+/g, ' ');
    this.params = [];
  }

  bind(...params) {
    this.params = params;
    return this;
  }

  async all() {
    return { results: this._execute() };
  }

  async run() {
    this._execute();
    return { success: true };
  }

  _execute() {
    const sql = this.sql;
    const p = this.params;

    let m = sql.match(/^SELECT \* FROM (\w+)(?: WHERE (\w+) (>|<|=) \?)?$/i);
    if (m) {
      const [, table, col, op] = m;
      let rows = this.db.data[table] || [];
      if (col && op) {
        const val = p[0];
        rows = rows.filter(r => {
          if (op === '>') return r[col] > val;
          if (op === '<') return r[col] < val;
          if (op === '=') return r[col] === val;
          return false;
        });
      }
      return rows.map(r => ({ ...r }));
    }

    m = sql.match(/^INSERT OR REPLACE INTO (\w+) \(([^)]+)\) VALUES \(([^)]+)\)$/i);
    if (m) {
      const [, table, colsStr, placeholders] = m;
      const cols = colsStr.split(',').map(s => s.trim());
      const phCount = placeholders.split(',').length;
      if (p.length !== phCount) {
        throw new Error(`参数数量不匹配: 期望 ${phCount}, 实际 ${p.length}`);
      }
      const row = {};
      cols.forEach((c, i) => { row[c] = p[i]; });

      const pk = table === 'voice_list' ? 'voice_name' : 'region';
      const rows = this.db.data[table] || [];
      const idx = rows.findIndex(r => r[pk] === row[pk]);
      if (idx >= 0) rows[idx] = row;
      else rows.push(row);
      this.db.data[table] = rows;
      return [];
    }

    m = sql.match(/^DELETE FROM (\w+)(?: WHERE (\w+) (>|<|=) \?)?$/i);
    if (m) {
      const [, table, col, op] = m;
      let rows = this.db.data[table] || [];
      if (col && op) {
        const val = p[0];
        rows = rows.filter(r => {
          if (op === '>') return !(r[col] > val);
          if (op === '<') return !(r[col] < val);
          if (op === '=') return r[col] !== val;
          return true;
        });
      } else {
        rows = [];
      }
      this.db.data[table] = rows;
      return [];
    }

    throw new Error(`不支持的 SQL: ${sql}`);
  }
}
