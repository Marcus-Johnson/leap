export interface RateLimit {
  interval: number;
  tasksPerInterval: number;
}

export interface TaskOptions {
  priority?: number;
  weight?: number;
  type?: string;
  cacheKey?: string;
  batchKey?: string; 
  id?: string | number;
  tags?: string[];
  metadata?: Record<string, any>;
  dependsOn?: (string | number)[];
  deadline?: number;
  signal?: AbortSignal;
  timeout?: number;
  retryCount?: number;
  retryDelay?: number;
  worker?: {
    path: string;
    data?: any;
  };
}

export interface Metrics {
  totalTasks: number;
  successfulTasks: number;
  failedTasks: number;
  throughput: string;
  errorRate: string;
  percentiles: {
    p50: string;
    p90: string;
    p99: string;
  };
}

export interface GlobalOptions {
  maxQueueSize?: number;
  workerPoolSize?: number;
  batchSize?: number;     
  batchTimeout?: number; 
  rateLimits?: Record<string, RateLimit>;
  circuitThreshold?: number;
  circuitResetTimeout?: number;
  retryCount?: number;
  initialRetryDelay?: number;
  retryFactor?: number;
  maxRetryDelay?: number;
  adaptive?: boolean;
  minConcurrency?: number;
  maxConcurrency?: number;
  interval?: number;
  tasksPerInterval?: number;
  agingThreshold?: number;
  agingBoost?: number;
  decayThreshold?: number;
  decayAmount?: number;
  emitter?: any;
  onEnqueue?: (task: any) => void;
  onDequeue?: (task: any) => void;
  beforeExecute?: (task: any) => void;
  afterExecute?: (task: any, profile: { 
    duration: number; 
    memoryDelta: number; 
    status: string; 
    error?: string 
  }) => void;
}

export interface PoolInstance {
  <T>(task: () => Promise<T>, options?: number | TaskOptions): Promise<T>;
  activeCount: number;
  pendingCount: number;
  currentLoad: number;
  concurrency: number;
  isDraining: boolean;
  isPaused: boolean;
  metrics: Metrics;
  pause(): void;
  resume(): void;
  cancel(query: { id?: string | number; tag?: string } | ((task: any) => boolean)): number;
  onIdle(): Promise<{ errors: Error[]; failed: boolean; metrics: Metrics }>;
  drain(): Promise<{ errors: Error[]; failed: boolean; metrics: Metrics }>;
  setConcurrency(limit: number): void;
  peek(): any;
  clear(): void;
  remove(predicate: (item: any) => boolean): boolean;
  map<T, R>(items: T[], fn: (item: T) => Promise<R>, opts?: number | TaskOptions): Promise<R[]>;
  useQueue(name: string, concurrency?: number): PoolInstance;
}

export default function leap(initialConcurrency: number, globalOptions?: GlobalOptions): PoolInstance;