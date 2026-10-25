import { createRequire } from 'node:module'

/**
 * SQLite 驱动适配层。
 *
 * 优先使用 Node.js 内置的 `node:sqlite`（Node >=22.5 可用，DSH 宿主要求 >=24.9），
 * 这样安装插件时不需要编译任何原生模块（不再依赖 better-sqlite3 的
 * prebuild-install / node-gyp，避开网络不通与编译工具链不兼容两类安装失败）。
 * 若运行环境没有内置实现，则回退到可选的 better-sqlite3（若已安装）。
 */

export interface SqliteRunResult {
  changes: number
  lastInsertRowid: number
}

export interface SqliteStatement {
  run(...params: unknown[]): SqliteRunResult
  get(...params: unknown[]): unknown
  all(...params: unknown[]): unknown[]
  /** 切换为「按列返回数组」模式，返回语句自身（与 better-sqlite3 语义一致）。 */
  raw(): SqliteStatement
}

export interface SqliteTransactionRunner<T> {
  (...args: unknown[]): T
  deferred: () => T
  immediate: () => T
  exclusive: () => T
  default: () => T
}

export interface SqliteDatabase {
  prepare(sql: string): SqliteStatement
  exec(sql: string): void
  pragma(source: string, options?: { simple?: boolean }): unknown
  transaction<T>(fn: (...args: unknown[]) => T): SqliteTransactionRunner<T>
  close(): void
}

/** node:sqlite 不接受 undefined 与 boolean，这里做与 better-sqlite3 一致的归一化。 */
function normalizeParams(params: unknown[]): unknown[] {
  return params.map(value => {
    if (value === undefined) return null
    if (typeof value === 'boolean') return value ? 1 : 0
    return value
  })
}

/** node:sqlite 返回 null 原型对象，转成普通对象，避免下游 spread 或原型判断踩坑。 */
function toPlainRow(row: unknown): unknown {
  if (row === null || typeof row !== 'object' || Array.isArray(row)) return row
  return { ...(row as Record<string, unknown>) }
}

class NodeSqliteStatement implements SqliteStatement {
  private rawMode = false

  constructor(private readonly stmt: {
    run: (...args: unknown[]) => { changes: number | bigint; lastInsertRowid: number | bigint }
    get: (...args: unknown[]) => unknown
    all: (...args: unknown[]) => unknown[]
    setReturnArrays: (value: boolean) => void
  }) {}

  private bind(params: unknown[]): unknown[] {
    return normalizeParams(params)
  }

  private useRawMode(): void {
    this.stmt.setReturnArrays(this.rawMode)
  }

  run(...params: unknown[]): SqliteRunResult {
    const result = this.stmt.run(...this.bind(params))
    return {
      changes: Number(result.changes),
      lastInsertRowid: Number(result.lastInsertRowid),
    }
  }

  get(...params: unknown[]): unknown {
    this.useRawMode()
    return toPlainRow(this.stmt.get(...this.bind(params)))
  }

  all(...params: unknown[]): unknown[] {
    this.useRawMode()
    return this.stmt.all(...this.bind(params)).map(toPlainRow)
  }

  raw(): SqliteStatement {
    this.rawMode = true
    return this
  }
}

class NodeSqliteDatabase implements SqliteDatabase {
  constructor(private readonly db: {
    prepare: (sql: string) => ConstructorParameters<typeof NodeSqliteStatement>[0]
    exec: (sql: string) => void
    close: () => void
  }) {}

  prepare(sql: string): SqliteStatement {
    return new NodeSqliteStatement(this.db.prepare(sql))
  }

  exec(sql: string): void {
    this.db.exec(sql)
  }

  pragma(source: string, options?: { simple?: boolean }): unknown {
    if (options?.simple) {
      const row = this.db.prepare(`PRAGMA ${source}`).get() as Record<string, unknown> | undefined
      if (!row) return undefined
      const key = Object.keys(row)[0]
      return key === undefined ? undefined : row[key]
    }
    this.db.exec(`PRAGMA ${source}`)
    return undefined
  }

  transaction<T>(fn: (...args: unknown[]) => T): SqliteTransactionRunner<T> {
    const run = (mode: 'DEFERRED' | 'IMMEDIATE' | 'EXCLUSIVE') => (): T => {
      this.db.exec(`BEGIN ${mode}`)
      try {
        const result = fn()
        this.db.exec('COMMIT')
        return result
      } catch (error) {
        try {
          this.db.exec('ROLLBACK')
        } catch {
          // 回滚失败不应掩盖原始错误
        }
        throw error
      }
    }
    const runner = run('DEFERRED') as SqliteTransactionRunner<T>
    runner.deferred = run('DEFERRED')
    runner.immediate = run('IMMEDIATE')
    runner.exclusive = run('EXCLUSIVE')
    runner.default = run('DEFERRED')
    return runner
  }

  close(): void {
    this.db.close()
  }
}

export class SqliteUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SqliteUnavailableError'
  }
}

/**
 * 打开 SQLite 数据库。
 * 优先 node:sqlite；不可用时回退 better-sqlite3（可选依赖，未安装则报明确错误）。
 */
export function openSqlite(path: string, cwd = process.cwd()): SqliteDatabase {
  const require = createRequire(`${cwd}/`)
  try {
    const { DatabaseSync } = require('node:sqlite') as {
      DatabaseSync: new (path: string) => ConstructorParameters<typeof NodeSqliteDatabase>[0]
    }
    return new NodeSqliteDatabase(new DatabaseSync(path))
  } catch (error) {
    const builtinError = error as Error
    try {
      const BetterSqlite3 = require('better-sqlite3') as new (path: string) => SqliteDatabase
      return new BetterSqlite3(path)
    } catch {
      throw new SqliteUnavailableError(
        `无法打开 SQLite：Node 内置 node:sqlite 不可用（${builtinError.message}），`
        + '且未安装可选的 better-sqlite3。请升级到 Node.js >=22.5，或执行 npm i better-sqlite3。',
      )
    }
  }
}
