import { DatabaseSync } from 'node:sqlite';

// Execute real SQLite SQL/transactions, converting returns to the D1 binding shape.
export class SqliteD1 {
  constructor() { this.sqlite = new DatabaseSync(':memory:'); this.sqlite.exec('PRAGMA foreign_keys=ON'); this.queries = 0; this.inject = null; }
  prepare(sql) {
    const db=this;
    return {
      sql, args: [],
      bind(...args) { return Object.assign(Object.create(this), {args}); },
      execute() {
        db.queries++;
        if(db.inject?.(sql,this.args)) throw new Error('injected SQLite failure');
        const stmt = db.sqlite.prepare(sql);
        const args=this.args.map(value=>value instanceof ArrayBuffer?new Uint8Array(value):value);
        let results;
        try { results=stmt.all(...args).map(row=>Object.fromEntries(Object.entries(row).map(([k,v])=>[k,v instanceof Uint8Array?Array.from(v):v]))); }
        catch(error) { throw error; }
        return {success:true, results, meta:{rows_read:results.length}};
      },
      async all() { return this.execute(); },
      async run() { return this.execute(); },
      async first(column) { const row=this.execute().results[0]; return row ? (column?row[column]:row) : null; },
    };
  }
  async batch(statements) {
    this.sqlite.exec('BEGIN');
    try { const result=statements.map(stmt=>stmt.execute()); this.sqlite.exec('COMMIT'); return result; }
    catch(error) { this.sqlite.exec('ROLLBACK'); throw error; }
  }
  async exec(sql) { this.sqlite.exec(sql); return {count:1,duration:0}; }
  close() { this.sqlite.close(); }
}
export function mediaEnv() { return {MEDIA_DB:new SqliteD1(), MEDIA_MAX_FILE_BYTES:'16777216', MEDIA_STORAGE_LIMIT_BYTES:'300000000'}; }
