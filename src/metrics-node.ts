import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  createFailOpenMetricsSink,
  createMetricRecord,
  type ConnectionContext,
  type MetricRecord,
  type MetricsEvent,
  type MetricsSink
} from "./metrics.js";
import {
  SqlMetricsStore,
  type MetricsSqlAdapter,
  type MetricsSqlRunResult,
  type MetricsSqlValue,
  type MetricsStoreOptions
} from "./metrics-store.js";

export interface NodeMetricsOptions extends MetricsStoreOptions {
  path: string;
  flushIntervalMs?: number;
  maxBatchSize?: number;
  maxQueueSize?: number;
  onError?: (error: unknown) => void;
}

export class NodeSqliteAdapter implements MetricsSqlAdapter {
  readonly database: DatabaseSync;

  constructor(path: string) {
    prepareDatabaseDirectory(path);
    this.database = new DatabaseSync(path);
    try {
      this.database.exec("PRAGMA journal_mode = WAL");
      this.database.exec("PRAGMA synchronous = NORMAL");
      this.database.exec("PRAGMA busy_timeout = 5000");
      if (path !== ":memory:") {
        chmodSync(path, 0o600);
      }
    } catch (error) {
      this.database.close();
      throw error;
    }
  }

  execute(sql: string): void {
    this.database.exec(sql);
  }

  run(sql: string, parameters: readonly MetricsSqlValue[] = []): MetricsSqlRunResult {
    const result = this.database.prepare(sql).run(...parameters);
    return { changes: Number(result.changes) };
  }

  all<Row>(sql: string, parameters: readonly MetricsSqlValue[] = []): Row[] {
    return this.database.prepare(sql).all(...parameters) as Row[];
  }

  transaction<T>(callback: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = callback();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  close(): void {
    this.database.close();
  }
}

export class NodeMetricsService implements MetricsSink {
  readonly store: SqlMetricsStore;
  readonly sink: MetricsSink;
  private readonly adapter: NodeSqliteAdapter;
  private readonly flushIntervalMs: number;
  private readonly maxBatchSize: number;
  private readonly maxQueueSize: number;
  private readonly onError: (error: unknown) => void;
  private readonly queue: MetricRecord[] = [];
  private flushTimer?: ReturnType<typeof setTimeout>;
  private closed = false;

  constructor(options: NodeMetricsOptions) {
    this.adapter = new NodeSqliteAdapter(options.path);
    try {
      this.store = new SqlMetricsStore(this.adapter, {
        source: options.source ?? "node",
        retentionMs: options.retentionMs,
        cleanupIntervalMs: options.cleanupIntervalMs
      });
    } catch (error) {
      this.adapter.close();
      throw error;
    }
    this.flushIntervalMs = options.flushIntervalMs ?? 5_000;
    this.maxBatchSize = options.maxBatchSize ?? 100;
    this.maxQueueSize = options.maxQueueSize ?? 10_000;
    this.onError = options.onError ?? (() => undefined);
    this.sink = createFailOpenMetricsSink(this, this.onError);
  }

  record(
    event: MetricsEvent,
    context: ConnectionContext = {},
    occurredAt: number | Date = Date.now()
  ): void {
    if (this.closed) {
      return;
    }
    const record = createMetricRecord(event, context, occurredAt);
    if (this.queue.length >= this.maxQueueSize) {
      this.queue.shift();
      safelyReport(this.onError, new Error("metrics queue is full; oldest record was dropped"));
    }
    this.queue.push(record);
    if (this.queue.length >= this.maxBatchSize) {
      this.flush();
      return;
    }
    this.scheduleFlush();
  }

  flush(): number {
    if (this.closed || this.queue.length === 0) {
      this.clearFlushTimer();
      return 0;
    }
    this.clearFlushTimer();
    const batch = this.queue.splice(0, this.maxBatchSize);
    try {
      this.store.write(batch);
    } catch (error) {
      const available = Math.max(0, this.maxQueueSize - this.queue.length);
      this.queue.unshift(...batch.slice(-available));
      safelyReport(this.onError, error);
      this.scheduleFlush();
      return 0;
    }
    if (this.queue.length > 0) {
      if (this.queue.length >= this.maxBatchSize) {
        queueMicrotask(() => this.flush());
      } else {
        this.scheduleFlush();
      }
    }
    return batch.length;
  }

  close(): void {
    if (this.closed) {
      return;
    }
    while (this.queue.length > 0) {
      const before = this.queue.length;
      this.flush();
      if (this.queue.length >= before) {
        break;
      }
    }
    this.closed = true;
    this.clearFlushTimer();
    this.adapter.close();
  }

  get queuedRecords(): number {
    return this.queue.length;
  }

  private scheduleFlush(): void {
    if (this.closed || this.flushTimer || this.queue.length === 0) {
      return;
    }
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      this.flush();
    }, this.flushIntervalMs);
    this.flushTimer.unref?.();
  }

  private clearFlushTimer(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
  }
}

function prepareDatabaseDirectory(path: string): void {
  if (path === ":memory:") {
    return;
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
}

function safelyReport(onError: (error: unknown) => void, error: unknown): void {
  try {
    onError(error);
  } catch {
    // Metrics errors must not affect the sync service.
  }
}
