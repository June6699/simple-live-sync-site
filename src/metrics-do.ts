import {
  SqlMetricsStore,
  type MetricsSqlAdapter,
  type MetricsSqlRunResult,
  type MetricsSqlValue,
  type MetricsStoreOptions
} from "./metrics-store.js";

export class DurableObjectMetricsSqlAdapter implements MetricsSqlAdapter {
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

export function createDurableObjectMetricsStore(
  storage: DurableObjectStorage,
  options: MetricsStoreOptions = {}
): SqlMetricsStore {
  return new SqlMetricsStore(new DurableObjectMetricsSqlAdapter(storage), {
    ...options,
    source: options.source ?? "cloudflare"
  });
}
