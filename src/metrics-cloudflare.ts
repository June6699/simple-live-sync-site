import type {
  MetricsSqlAdapter,
  MetricsSqlRunResult,
  MetricsSqlValue
} from "./metrics-store.js";

export class DurableObjectSqlAdapter implements MetricsSqlAdapter {
  constructor(private readonly storage: DurableObjectStorage) {}

  execute(sql: string): void {
    this.storage.sql.exec(sql);
  }

  run(sql: string, parameters: readonly MetricsSqlValue[] = []): MetricsSqlRunResult {
    const cursor = this.storage.sql.exec(sql, ...parameters);
    return { changes: cursor.rowsWritten };
  }

  all<Row>(sql: string, parameters: readonly MetricsSqlValue[] = []): Row[] {
    return this.storage.sql.exec(sql, ...parameters).toArray() as Row[];
  }

  transaction<T>(callback: () => T): T {
    return this.storage.transactionSync(callback);
  }
}
