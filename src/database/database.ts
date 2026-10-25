import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import * as schema from './schema.js'
import { MIGRATION_1 } from './migrations.js'

export type NovelDatabase = ReturnType<typeof drizzle<typeof schema>>

export interface DatabaseHandle {
  sqlite: Database.Database
  db: NovelDatabase
  close: () => void
}

export function openDatabase(path: string): DatabaseHandle {
  const resolved = path === ':memory:' ? path : resolve(path)
  if (resolved !== ':memory:') mkdirSync(dirname(resolved), { recursive: true })
  const sqlite = new Database(resolved)
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
  const db = drizzle(sqlite, { schema })
  return { sqlite, db, close: () => sqlite.close() }
}
