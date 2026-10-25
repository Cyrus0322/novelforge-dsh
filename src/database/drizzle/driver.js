// 本地化自 drizzle-orm 0.44.7 的 better-sqlite3 同步 driver（MIT License，版权归 Drizzle Team）。
// 与原版唯一的区别：不 import better-sqlite3、不会自行 new 连接，只包装调用方给的句柄。
// 原文件：node_modules/drizzle-orm/better-sqlite3/driver.js
import { entityKind } from "drizzle-orm/entity";
import { DefaultLogger } from "drizzle-orm/logger";
import {
  createTableRelationsHelpers,
  extractTablesRelationalConfig
} from "drizzle-orm/relations";
import { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core/db";
import { SQLiteSyncDialect } from "drizzle-orm/sqlite-core/dialect";
import { isConfig } from "drizzle-orm/utils";
import { BetterSQLiteSession } from "./session.js";
class BetterSQLite3Database extends BaseSQLiteDatabase {
  static [entityKind] = "BetterSQLite3Database";
}
function construct(client, config = {}) {
  const dialect = new SQLiteSyncDialect({ casing: config.casing });
  let logger;
  if (config.logger === true) {
    logger = new DefaultLogger();
  } else if (config.logger !== false) {
    logger = config.logger;
  }
  let schema;
  if (config.schema) {
    const tablesConfig = extractTablesRelationalConfig(
      config.schema,
      createTableRelationsHelpers
    );
    schema = {
      fullSchema: config.schema,
      schema: tablesConfig.tables,
      tableNamesMap: tablesConfig.tableNamesMap
    };
  }
  const session = new BetterSQLiteSession(client, dialect, schema, { logger });
  const db = new BetterSQLite3Database("sync", dialect, session, schema);
  db.$client = client;
  return db;
}
function drizzle(...params) {
  if (params[0] === void 0) {
    throw new Error("novelforge: 需要传入数据库句柄（node:sqlite 或 better-sqlite3），本驱动不会自行创建连接。");
  }
  if (isConfig(params[0])) {
    const { client, ...drizzleConfig } = params[0];
    if (!client) {
      throw new Error("novelforge: 传入 config 时必须提供 client 句柄。");
    }
    return construct(client, drizzleConfig);
  }
  return construct(params[0], params[1]);
}
((drizzle2) => {
  function mock(config) {
    return construct({}, config);
  }
  drizzle2.mock = mock;
})(drizzle || (drizzle = {}));
export {
  BetterSQLite3Database,
  drizzle
};
