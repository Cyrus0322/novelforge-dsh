import { drizzle } from 'drizzle-orm/better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import * as schema from './schema.js'
import { MIGRATION_1 } from './migrations.js'
import { openSqlite } from './sqlite.js'
import type { SqliteDatabase } from './sqlite.js'

export type NovelDatabase = ReturnType<typeof drizzle<typeof schema>>

export interface DatabaseHandle {
  sqlite: SqliteDatabase
  db: NovelDatabase
  close: () => void
}

export function openDatabase(path: string): DatabaseHandle {
  const resolved = path === ':memory:' ? path : resolve(path)
  if (resolved !== ':memory:') mkdirSync(dirname(resolved), { recursive: true })
  const sqlite = openSqlite(resolved)
  sqlite.pragma('foreign_keys = ON')
  sqlite.pragma('busy_timeout = 5000')
  if (resolved !== ':memory:') sqlite.pragma('journal_mode = WAL')
  const version = sqlite.pragma('user_version', { simple: true }) as number
  if (version > 1) {
    sqlite.close()
    throw new Error(`数据库版本 ${version} 高于本插件支持的版本 1，请升级 NovelForge。`)
  }
  if (version < 1) {
    sqlite.transaction(() => {
      sqlite.exec(MIGRATION_1)
      sqlite.pragma('user_version = 1')
    })()
  }
  // drizzle 的 better-sqlite3 驱动只按结构化契约使用句柄（prepare/run/raw/all/get/transaction），
  // 与底层是 node:sqlite 还是 better-sqlite3 无关，故此处做一次结构性类型转换。
  const db = drizzle(sqlite as never, { schema }) as NovelDatabase
  return { sqlite, db, close: () => sqlite.close() }
}
