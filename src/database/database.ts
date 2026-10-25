import { drizzle } from './drizzle/driver.js'
// 仅类型导入：运行时完全不依赖 better-sqlite3（它是可选 peer），只是复用 drizzle 的数据库类型。
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import * as schema from './schema.js'
import { MIGRATION_1 } from './migrations.js'
import { openSqlite } from './sqlite.js'
import type { SqliteDatabase } from './sqlite.js'

export type NovelDatabase = BetterSQLite3Database<typeof schema>

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
  // 本地化的 drizzle 同步驱动（src/database/drizzle/）只按结构化契约使用句柄
  // （prepare/run/raw/all/get/transaction），因此 node:sqlite 与 better-sqlite3 句柄都能直接喂进去；
  // 这样发布到 npm 后即使完全没装 better-sqlite3（可选 peer）也能正常打开数据库。
  const db = drizzle(sqlite as never, { schema }) as unknown as NovelDatabase
  return { sqlite, db, close: () => sqlite.close() }
}
