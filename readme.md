# Smart Pool [![CI](https://github.com/Marcus-Johnson/smart-pool/actions/workflows/ci.yml/badge.svg)](https://github.com/Marcus-Johnson/smart-pool/actions) 

A high-performance, feature-rich task queue and concurrency management library for Node.js. Built for production workloads requiring advanced scheduling, priority management, batching, rate limiting, circuit breaking, worker thread support, and adaptive concurrency.



## Features

- **Priority Queue**: Binary max-heap with dynamic priority adjustments
- **Concurrency Control**: Fixed or adaptive concurrency limits
- **Rate Limiting**: Per-type rate limits with token bucket algorithm
- **Circuit Breakers**: Automatic failure detection and recovery
- **Task Batching**: Group similar tasks for efficient processing
- **Worker Threads**: Offload CPU-intensive tasks to worker threads
- **Task Dependencies**: Execute tasks only after dependencies complete
- **Caching**: Deduplicate identical pending tasks
- **Retry Logic**: Exponential backoff with configurable limits
- **Abort Support**: Cancel tasks via AbortSignal
- **Priority Aging**: Prevent starvation with automatic priority boosts
- **Priority Decay**: Reduce priority of stale high-priority tasks
- **Metrics**: Real-time performance tracking with percentiles
- **Lifecycle Hooks**: Execute code at key points in task execution
- **Sub-queues**: Isolated queues with independent concurrency limits
- **Weight-based Load**: Track and limit load by task weight

## Installation

```bash
npm install smart-pool
```

## Quick Start

```javascript
import smartPool from 'smart-pool';

const pool = smartPool(5);

const result = await pool(async () => {
  return 'Task completed';
});

console.log(result);
```

## API Reference

### `smartPool(concurrency, options)`

Creates a new task pool instance.

**Parameters:**
- `concurrency` (number): Maximum number of concurrent tasks (minimum 1)
- `options` (object, optional): Global configuration options

**Returns:** PoolInstance

### Pool Instance

#### Methods

##### `pool(task, options)`

Enqueue and execute a task.

**Parameters:**
- `task` (function): Async function to execute
- `options` (number | object): Priority (number) or task options (object)

**Task Options:**
- `priority` (number): Task priority (higher = executed sooner). Default: 0
- `weight` (number): Task weight for load tracking. Default: 1
- `type` (string): Task type for rate limiting and circuit breaking
- `cacheKey` (string): Deduplicate identical pending tasks
- `batchKey` (string): Group tasks for batch processing
- `id` (string | number): Unique task identifier
- `tags` (string[]): Tags for filtering/cancellation
- `metadata` (object): Custom metadata
- `dependsOn` (array): Task IDs that must complete first
- `deadline` (number): Unix timestamp when task expires
- `signal` (AbortSignal): Abort signal for cancellation
- `timeout` (number): Task timeout in milliseconds
- `retryCount` (number): Maximum retry attempts
- `retryDelay` (number): Initial retry delay in milliseconds
- `worker` (object): Worker thread configuration
  - `path` (string): Path to worker script
  - `data` (any): Data to pass to worker

**Returns:** Promise resolving to task result

**Example:**
```javascript
const result = await pool(
  async () => fetchData(),
  {
    priority: 10,
    type: 'api',
    retryCount: 3,
    timeout: 5000
  }
);
```

##### `pool.map(items, fn, options)`

Map function over array items using the pool.

**Parameters:**
- `items` (array): Items to process
- `fn` (function): Async function to apply to each item
- `options` (number | object): Priority or task options
  - `throwOnError` (boolean): Throw on first error. Default: true

**Returns:** Promise<array> with results

**Example:**
```javascript
const results = await pool.map(
  [1, 2, 3, 4, 5],
  async (n) => n * 2,
  { priority: 5 }
);
```

##### `pool.pause()`

Pause task execution. Queued tasks remain in queue.

**Example:**
```javascript
pool.pause();
console.log(pool.isPaused);
```

##### `pool.resume()`

Resume task execution after pause.

**Example:**
```javascript
pool.resume();
```

##### `pool.cancel(query)`

Cancel pending tasks matching criteria.

**Parameters:**
- `query` (object | function): 
  - Object: `{ id, tag }` to match tasks
  - Function: `(task) => boolean` predicate

**Returns:** Number of cancelled tasks

**Example:**
```javascript
await pool(async () => work(), { id: 'task-1', tags: ['batch-1'] });
await pool(async () => work(), { id: 'task-2', tags: ['batch-1'] });

pool.cancel({ tag: 'batch-1' });

pool.cancel((task) => task.priority < 5);
```

##### `pool.onIdle()`

Wait for all tasks to complete, including batched and blocked tasks.

**Returns:** Promise<{ errors, failed, metrics }>

**Example:**
```javascript
const { errors, failed, metrics } = await pool.onIdle();
console.log(`Completed with ${errors.length} errors`);
```

##### `pool.drain()`

Stop accepting new tasks and wait for completion. Equivalent to setting drain mode + onIdle.

**Returns:** Promise<{ errors, failed, metrics }>

**Example:**
```javascript
await pool.drain();
console.log('All tasks completed, pool drained');
```

##### `pool.clear()`

Cancel all pending tasks and terminate all workers. Resets pool state.

**Returns:** Promise<void>

**Example:**
```javascript
await pool.clear();
console.log('Pool cleared');
```

##### `pool.setConcurrency(limit)`

Dynamically adjust concurrency limit.

**Parameters:**
- `limit` (number): New concurrency limit

**Example:**
```javascript
pool.setConcurrency(10);
console.log(pool.concurrency);
```

##### `pool.peek()`

View the next task to be executed without removing it.

**Returns:** Task object or null

**Example:**
```javascript
const nextTask = pool.peek();
console.log(nextTask?.priority);
```

##### `pool.remove(predicate)`

Remove tasks from queue matching predicate.

**Parameters:**
- `predicate` (function): `(task) => boolean`

**Returns:** Boolean indicating if any tasks were removed

**Example:**
```javascript
pool.remove((task) => task.priority < 3);
```

##### `pool.useQueue(name, concurrency)`

Create or get an isolated sub-queue with independent concurrency control.

**Parameters:**
- `name` (string): Sub-queue identifier
- `concurrency` (number, optional): Sub-queue concurrency. Default: parent concurrency

**Returns:** PoolInstance for the sub-queue

**Example:**
```javascript
const apiQueue = pool.useQueue('api', 3);
const dbQueue = pool.useQueue('database', 5);

await apiQueue(async () => fetchAPI());
await dbQueue(async () => queryDB());
```

##### `pool.getWorkerHealth()`

Get health status of all worker threads.

**Returns:** Array<{ path, busy, active }>

**Example:**
```javascript
const health = pool.getWorkerHealth();
health.forEach(w => {
  console.log(`Worker ${w.path}: ${w.busy ? 'busy' : 'idle'}`);
});
```

#### Properties

##### `pool.activeCount`

Number of currently executing tasks (read-only).

##### `pool.pendingCount`

Number of tasks waiting in queue, batches, or blocked by dependencies (read-only).

##### `pool.currentLoad`

Current total weight of active tasks (read-only).

##### `pool.concurrency`

Current concurrency limit (read-only).

##### `pool.isDraining`

Whether pool is in drain mode (read-only).

##### `pool.isPaused`

Whether pool is paused (read-only).

##### `pool.metrics`

Performance metrics object (read-only):
- `totalTasks`: Total tasks processed
- `successfulTasks`: Successful task count
- `failedTasks`: Failed task count
- `throughput`: Tasks per second (formatted string)
- `errorRate`: Failure rate (formatted string)
- `percentiles`: Latency percentiles
  - `p50`: Median latency (ms)
  - `p90`: 90th percentile (ms)
  - `p99`: 99th percentile (ms)

### Global Options

Configure pool behavior during initialization:

```javascript
const pool = smartPool(5, {
  // Queue Management
  maxQueueSize: 10000,
  
  // Adaptive Concurrency
  adaptive: true,
  minConcurrency: 2,
  maxConcurrency: 20,
  
  // Rate Limiting
  rateLimits: {
    api: { interval: 1000, tasksPerInterval: 10 },
    database: { interval: 100, tasksPerInterval: 5 }
  },
  
  // Circuit Breaker
  circuitThreshold: 5,
  circuitResetTimeout: 30000,
  
  // Batching
  batchSize: 10,
  batchTimeout: 100,
  
  // Retry
  retryCount: 3,
  initialRetryDelay: 100,
  retryFactor: 2,
  maxRetryDelay: 10000,
  
  // Priority Management
  agingThreshold: 5,
  agingBoost: 1,
  decayThreshold: 10,
  decayAmount: 1,
  
  // Worker Threads
  workerPoolSize: 4,
  workerPathWhitelist: ['/app/workers/'],
  
  // Maintenance
  interval: 1000,
  completedTaskCleanupMs: 60000,
  maxLatencyHistory: 10000,
  maxErrorHistory: 1000,
  
  // Events
  emitter: eventEmitter,
  
  // Lifecycle Hooks
  onEnqueue: (task) => console.log('Enqueued:', task.id),
  onDequeue: (task) => console.log('Dequeued:', task.id),
  beforeExecute: (task) => console.log('Executing:', task.id),
  afterExecute: (task, profile) => {
    console.log('Completed:', task.id, profile.duration, 'ms');
  }
});
```

**Option Descriptions:**

**Queue Management:**
- `maxQueueSize`: Maximum number of queued tasks. Default: 10000

**Adaptive Concurrency:**
- `adaptive`: Enable automatic concurrency adjustment. Default: false
- `minConcurrency`: Minimum concurrent tasks. Default: 1
- `maxConcurrency`: Maximum concurrent tasks. Default: 2x initial concurrency

**Rate Limiting:**
- `rateLimits`: Per-type rate limits using token bucket
  - `interval`: Time window in milliseconds
  - `tasksPerInterval`: Tasks allowed per interval

**Circuit Breaker:**
- `circuitThreshold`: Consecutive failures to open circuit. Default: 5
- `circuitResetTimeout`: Time before retry after circuit opens (ms). Default: 30000

**Batching:**
- `batchSize`: Tasks per batch. Default: 10
- `batchTimeout`: Max wait time before flushing partial batch (ms). Default: 100

**Retry:**
- `retryCount`: Default retry attempts. Default: 0
- `initialRetryDelay`: Initial retry delay (ms). Default: 100
- `retryFactor`: Backoff multiplier. Default: 2
- `maxRetryDelay`: Maximum retry delay (ms). Default: 10000

**Priority Management:**
- `agingThreshold`: Cycles before boosting low-priority tasks. Default: undefined
- `agingBoost`: Priority increase amount. Default: 1
- `decayThreshold`: Cycles before decaying high-priority tasks. Default: undefined
- `decayAmount`: Priority decrease amount. Default: 1

**Worker Threads:**
- `workerPoolSize`: Maximum worker threads. Default: 0 (disabled)
- `workerPathWhitelist`: Allowed worker script paths

**Maintenance:**
- `interval`: Maintenance cycle interval (ms). Default: 1000
- `completedTaskCleanupMs`: Time before cleaning completed task records (ms). Default: 60000
- `maxLatencyHistory`: Maximum latency samples to retain. Default: 10000
- `maxErrorHistory`: Maximum error samples to retain. Default: 1000

**Events:**
- `emitter`: EventEmitter instance for pool events

**Lifecycle Hooks:**
- `onEnqueue`: Called when task added to queue
- `onDequeue`: Called when task removed from queue
- `beforeExecute`: Called before task execution
- `afterExecute`: Called after task execution with profile data

## Tutorials

### 1. Basic Task Queue

Simple task queue with priority management:

```javascript
import smartPool from 'smart-pool';

const pool = smartPool(3);

await pool(async () => {
  console.log('Low priority task');
}, 1);

await pool(async () => {
  console.log('High priority task');
}, 10);

await pool.onIdle();
```

### 2. API Rate Limiting

Respect API rate limits with type-based limiting:

```javascript
const pool = smartPool(10, {
  rateLimits: {
    github: { interval: 3600000, tasksPerInterval: 5000 },
    twitter: { interval: 900000, tasksPerInterval: 300 }
  }
});

async function fetchGithubUser(username) {
  return pool(
    async () => {
      const res = await fetch(`https://api.github.com/users/${username}`);
      return res.json();
    },
    { type: 'github', priority: 5 }
  );
}

async function fetchTweet(id) {
  return pool(
    async () => {
      const res = await fetch(`https://api.twitter.com/tweets/${id}`);
      return res.json();
    },
    { type: 'twitter', priority: 3 }
  );
}

const users = await Promise.all([
  fetchGithubUser('alice'),
  fetchGithubUser('bob'),
  fetchGithubUser('charlie')
]);
```

### 3. Task Batching

Batch database operations for efficiency:

```javascript
const pool = smartPool(5, {
  batchSize: 50,
  batchTimeout: 100
});

async function insertUser(user) {
  return pool(
    async (batch) => {
      const ids = await db.users.insertMany(batch.map(t => t.data));
      return ids[batch.indexOf(user)];
    },
    {
      batchKey: 'user-insert',
      data: user
    }
  );
}

const users = Array.from({ length: 200 }, (_, i) => ({
  name: `User ${i}`,
  email: `user${i}@example.com`
}));

const ids = await Promise.all(users.map(insertUser));
console.log(`Inserted ${ids.length} users in batches`);
```

### 4. Circuit Breaker

Protect external services from cascading failures:

```javascript
const pool = smartPool(5, {
  circuitThreshold: 3,
  circuitResetTimeout: 30000,
  retryCount: 2,
  initialRetryDelay: 1000
});

async function callUnstableAPI(endpoint) {
  return pool(
    async () => {
      const res = await fetch(endpoint);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    { type: 'unstable-api' }
  );
}

try {
  const data = await callUnstableAPI('https://api.example.com/data');
  console.log(data);
} catch (err) {
  console.error('API call failed:', err.message);
}
```

### 5. Worker Threads

Offload CPU-intensive work to worker threads:

**worker.js:**
```javascript
import { parentPort } from 'node:worker_threads';

parentPort.on('message', ({ data }) => {
  const result = expensiveComputation(data);
  parentPort.postMessage({ result });
});

function expensiveComputation(n) {
  let sum = 0;
  for (let i = 0; i < n; i++) {
    sum += Math.sqrt(i);
  }
  return sum;
}
```

**main.js:**
```javascript
const pool = smartPool(5, {
  workerPoolSize: 4,
  workerPathWhitelist: ['/app/workers/']
});

const results = await pool.map(
  [1000000, 2000000, 3000000],
  async (n) => {
    return pool(
      async () => {},
      {
        worker: {
          path: '/app/workers/worker.js',
          data: n
        }
      }
    );
  }
);

console.log(results);
```

### 6. Task Dependencies

Execute tasks after dependencies complete:

```javascript
const pool = smartPool(10);

const userId = await pool(
  async () => db.users.create({ name: 'Alice' }),
  { id: 'create-user' }
);

const profileId = await pool(
  async () => db.profiles.create({ userId, bio: 'Developer' }),
  { id: 'create-profile', dependsOn: ['create-user'] }
);

await pool(
  async () => sendWelcomeEmail(userId),
  { dependsOn: ['create-user', 'create-profile'] }
);
```

### 7. Task Caching

Deduplicate identical pending requests:

```javascript
const pool = smartPool(5);

async function fetchUserData(userId) {
  return pool(
    async () => {
      console.log(`Fetching user ${userId}`);
      const res = await fetch(`https://api.example.com/users/${userId}`);
      return res.json();
    },
    { cacheKey: `user-${userId}` }
  );
}

const [user1, user2, user3] = await Promise.all([
  fetchUserData(123),
  fetchUserData(123),
  fetchUserData(123)
]);

console.log('Only one request made');
```

### 8. Adaptive Concurrency

Automatically adjust concurrency based on performance:

```javascript
const pool = smartPool(5, {
  adaptive: true,
  minConcurrency: 2,
  maxConcurrency: 20,
  adaptiveLatencyLow: 50,
  adaptiveLatencyHigh: 200
});

for (let i = 0; i < 1000; i++) {
  pool(async () => {
    await simulateWork();
  });
}

setInterval(() => {
  console.log(`Current concurrency: ${pool.concurrency}`);
  console.log(`Active tasks: ${pool.activeCount}`);
  console.log(`Pending tasks: ${pool.pendingCount}`);
}, 1000);

await pool.onIdle();
```

### 9. Priority Aging

Prevent task starvation with automatic priority boosts:

```javascript
const pool = smartPool(3, {
  agingThreshold: 5,
  agingBoost: 1,
  interval: 1000
});

for (let i = 0; i < 100; i++) {
  pool(
    async () => {
      console.log(`Task ${i}`);
      await sleep(100);
    },
    { priority: i < 10 ? 1 : 10 }
  );
}

await pool.onIdle();
```

### 10. Sub-queues

Isolate different workload types:

```javascript
const pool = smartPool(10);

const criticalQueue = pool.useQueue('critical', 5);
const backgroundQueue = pool.useQueue('background', 2);

await criticalQueue(async () => {
  await processPayment();
});

await backgroundQueue(async () => {
  await generateReport();
});

console.log(`Critical active: ${criticalQueue.activeCount}`);
console.log(`Background active: ${backgroundQueue.activeCount}`);
```

### 11. Timeout and Abort

Cancel tasks via timeout or AbortSignal:

```javascript
const pool = smartPool(5);

const controller = new AbortController();

const timeoutTask = pool(
  async () => {
    await longRunningOperation();
  },
  { timeout: 5000 }
);

const abortTask = pool(
  async () => {
    await anotherOperation();
  },
  { signal: controller.signal }
);

setTimeout(() => controller.abort(), 2000);

try {
  await Promise.all([timeoutTask, abortTask]);
} catch (err) {
  console.error('Task cancelled:', err.message);
}
```

### 12. Metrics and Monitoring

Track performance metrics:

```javascript
const pool = smartPool(10);

for (let i = 0; i < 1000; i++) {
  pool(async () => {
    await simulateWork();
  });
}

await pool.onIdle();

const metrics = pool.metrics;
console.log(`Total tasks: ${metrics.totalTasks}`);
console.log(`Success rate: ${((1 - parseFloat(metrics.errorRate)) * 100).toFixed(2)}%`);
console.log(`Throughput: ${metrics.throughput} tasks/sec`);
console.log(`Latency p50: ${metrics.percentiles.p50}ms`);
console.log(`Latency p90: ${metrics.percentiles.p90}ms`);
console.log(`Latency p99: ${metrics.percentiles.p99}ms`);
```

### 13. Lifecycle Hooks

Monitor task execution:

```javascript
const pool = smartPool(5, {
  onEnqueue: (task) => {
    console.log(`[ENQUEUE] ${task.id || 'anonymous'} (priority: ${task.priority})`);
  },
  onDequeue: (task) => {
    console.log(`[DEQUEUE] ${task.id || 'anonymous'}`);
  },
  beforeExecute: (task) => {
    console.log(`[EXECUTE] ${task.id || 'anonymous'}`);
  },
  afterExecute: (task, profile) => {
    console.log(`[COMPLETE] ${task.id || 'anonymous'} in ${profile.duration}ms`);
    if (profile.error) {
      console.error(`[ERROR] ${profile.error}`);
    }
  }
});

await pool(async () => {
  await performWork();
}, { id: 'my-task', priority: 10 });
```

### 14. Weight-based Load

Track and limit load by task weight:

```javascript
const pool = smartPool(100);

async function cpuIntensiveTask() {
  return pool(
    async () => {
      return performComputation();
    },
    { weight: 10 }
  );
}

async function lightweightTask() {
  return pool(
    async () => {
      return fetchData();
    },
    { weight: 1 }
  );
}

await Promise.all([
  ...Array(5).fill().map(cpuIntensiveTask),
  ...Array(50).fill().map(lightweightTask)
]);

console.log(`Current load: ${pool.currentLoad}`);
```

### 15. Task Cancellation

Cancel tasks by ID, tag, or predicate:

```javascript
const pool = smartPool(5);

for (let i = 0; i < 100; i++) {
  pool(
    async () => {
      await processItem(i);
    },
    {
      id: `task-${i}`,
      tags: i % 2 === 0 ? ['even'] : ['odd'],
      priority: i
    }
  ).catch(err => {
    if (err.message === 'Task cancelled via API') {
      console.log(`Task ${i} was cancelled`);
    }
  });
}

pool.cancel({ tag: 'even' });

pool.cancel((task) => task.priority < 50);

await pool.onIdle();
```

## Events

When an emitter is provided, the pool emits these events:

- `circuit:open` - Circuit breaker opened
- `circuit:closed` - Circuit breaker closed
- `concurrency:adjust` - Adaptive concurrency changed
- `task:retry` - Task retry attempt
- `task:timeout` - Task timeout
- `batch:flush` - Batch flushed

```javascript
import { EventEmitter } from 'events';

const emitter = new EventEmitter();
const pool = smartPool(5, { emitter });

emitter.on('circuit:open', ({ type }) => {
  console.log(`Circuit opened for ${type}`);
});

emitter.on('concurrency:adjust', ({ concurrency, reason }) => {
  console.log(`Concurrency adjusted to ${concurrency}: ${reason}`);
});

emitter.on('task:retry', ({ id, attempt, delay }) => {
  console.log(`Retrying task ${id} (attempt ${attempt}) after ${delay}ms`);
});
```

## Best Practices

### 1. Choose Appropriate Concurrency

Start conservative and adjust based on metrics:

```javascript
const pool = smartPool(5, {
  adaptive: true,
  minConcurrency: 2,
  maxConcurrency: 20
});
```

### 2. Use Type-based Rate Limiting

Respect external API limits:

```javascript
const pool = smartPool(10, {
  rateLimits: {
    'api-provider': { interval: 60000, tasksPerInterval: 100 }
  }
});
```

### 3. Implement Circuit Breakers

Protect against cascading failures:

```javascript
const pool = smartPool(5, {
  circuitThreshold: 5,
  circuitResetTimeout: 30000,
  retryCount: 3
});
```

### 4. Batch Similar Operations

Reduce overhead for bulk operations:

```javascript
const pool = smartPool(5, {
  batchSize: 100,
  batchTimeout: 50
});
```

### 5. Use Sub-queues for Isolation

Separate critical and background work:

```javascript
const critical = pool.useQueue('critical', 10);
const background = pool.useQueue('background', 2);
```

### 6. Monitor Metrics

Track performance and adjust configuration:

```javascript
setInterval(() => {
  const { throughput, errorRate, percentiles } = pool.metrics;
  console.log({ throughput, errorRate, p99: percentiles.p99 });
}, 5000);
```

### 7. Handle Errors Gracefully

Always catch and handle task errors:

```javascript
try {
  await pool(async () => riskyOperation());
} catch (err) {
  console.error('Task failed:', err);
}
```

### 8. Clean Up Resources

Always drain or clear the pool on shutdown:

```javascript
process.on('SIGTERM', async () => {
  await pool.drain();
  process.exit(0);
});
```

## Performance Tips

1. **Batch when possible**: Use `batchKey` for operations that can be grouped
2. **Enable adaptive mode**: Let the pool optimize concurrency automatically
3. **Use worker threads**: Offload CPU-intensive tasks to avoid blocking
4. **Cache duplicate requests**: Use `cacheKey` to deduplicate pending tasks
5. **Set appropriate priorities**: High-priority tasks execute first
6. **Monitor metrics**: Use percentiles to identify bottlenecks
7. **Tune rate limits**: Match external service limits
8. **Use sub-queues**: Isolate different workload types

## License

MIT