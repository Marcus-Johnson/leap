import test, { afterEach } from 'node:test';
import assert from 'node:assert';
import { writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import leap from '../src/index.js';

const pools = [];
function createPool(concurrency, opts) {
  const p = leap(concurrency, opts);
  pools.push(p);
  return p;
}

afterEach(async () => {
  while (pools.length > 0) {
    const p = pools.pop();
    p.clear(); 
  }
});

test('LEAP should respect concurrency limits', async () => {
  const pool = createPool(2);
  let active = 0;
  let maxActive = 0;

  const task = async () => {
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise(r => setTimeout(r, 10));
    active--;
  };

  await Promise.all([pool(task), pool(task), pool(task), pool(task)]);
  assert.strictEqual(maxActive, 2, 'Should not exceed concurrency of 2');
});

test('High priority tasks should leap ahead in the queue', async () => {
  const pool = createPool(1);
  const executionOrder = [];

  pool(() => new Promise(r => setTimeout(() => {
    executionOrder.push('slow');
    r();
  }, 20)));

  pool(() => executionOrder.push('low'), 0);
  pool(() => executionOrder.push('high'), 10);

  await pool.onIdle();
  assert.deepStrictEqual(executionOrder, ['slow', 'high', 'low']);
});

test('Retry logic should re-run failed tasks with backoff', async () => {
  const pool = createPool(1, { initialRetryDelay: 5 }); 
  let attempts = 0;

  await pool(() => {
    attempts++;
    if (attempts < 3) throw new Error('Fail');
    return 'Success';
  }, { retryCount: 2 });

  assert.strictEqual(attempts, 3, 'Should have attempted 3 times total');
});

test('Circuit Breaker should open on failures and block execution', async () => {
  const pool = createPool(2, { 
    circuitThreshold: 3, 
    circuitResetTimeout: 50,
    interval: 10 
  });
  
  let executedAfterOpen = false;
  const failTask = () => Promise.reject(new Error('Persistent Failure'));
  
  await Promise.allSettled([pool(failTask), pool(failTask), pool(failTask)]);

  const p = pool(() => { executedAfterOpen = true; return 'Success'; });
  
  await new Promise(r => setTimeout(r, 20));
  assert.strictEqual(executedAfterOpen, false, 'Task should be blocked while circuit is open');

  await new Promise(r => setTimeout(r, 100));
  await p;
  assert.strictEqual(executedAfterOpen, true, 'Task should execute after circuit resets');
});

test('Worker threads should execute tasks in separate threads', async () => {
  const workerPath = join(process.cwd(), 'test-worker.js');
  const workerCode = `
    import { parentPort } from 'node:worker_threads';
    parentPort.on('message', (data) => {
      parentPort.postMessage({ result: data.input * 2 });
    });
  `;
  
  await writeFile(workerPath, workerCode);
  
  try {
    const pool = createPool(1, { workerPoolSize: 1 });
    const result = await pool(() => {}, { 
      worker: { path: workerPath, data: { input: 21 } } 
    });
    
    assert.strictEqual(result.result, 42, 'Worker should process data and return result');
  } finally {
    await unlink(workerPath);
  }
});

test('Task Dependencies should execute in DAG order', async () => {
  const pool = createPool(2);
  const results = [];

  const t1 = pool(() => results.push('A'), { id: 'taskA' });
  const t2 = pool(() => results.push('B'), { id: 'taskB', dependsOn: ['taskA'] });
  const t3 = pool(() => results.push('C'), { id: 'taskC', dependsOn: ['taskB'] });

  await Promise.all([t1, t2, t3]);
  assert.deepStrictEqual(results, ['A', 'B', 'C']);
});

test('Priority Aging should prevent starvation', async () => {
  const pool = createPool(1, { 
    agingThreshold: 1, 
    agingBoost: 10, 
    interval: 20 
  });
  
  const order = [];
  pool(() => new Promise(r => setTimeout(r, 50)));
  pool(() => order.push('low'), { priority: 0 });
  
  setTimeout(() => {
    pool(() => order.push('high'), { priority: 5 });
  }, 10);

  await pool.onIdle();
  assert.strictEqual(order[0], 'low', 'Aging should have boosted low priority task above high');
});

test('Sub-queues (useQueue) should have isolated concurrency', async () => {
  const mainPool = createPool(5);
  const cpuQueue = mainPool.useQueue('cpu', 1);

  let cpuActive = 0;
  const cpuTask = async () => {
    cpuActive++;
    await new Promise(r => setTimeout(r, 10));
    const current = cpuActive;
    cpuActive--;
    return current;
  };

  const results = await Promise.all([cpuQueue(cpuTask), cpuQueue(cpuTask)]);
  assert.ok(results.every(val => val <= 1), 'CPU queue exceeded its isolated limit');
});

test('maxQueueSize should reject tasks when full', async () => {
  const pool = createPool(1, { maxQueueSize: 1 });
  pool(() => new Promise(r => setTimeout(r, 50)));
  pool(() => Promise.resolve('queued')); 
  
  await assert.rejects(
    pool(() => Promise.resolve('rejected')),
    { message: 'Queue size limit exceeded' }
  );
});

test('cancel should remove tasks from buffers', async () => {
  const pool = createPool(1);
  const p1 = pool(() => new Promise(r => setTimeout(r, 50)), { id: 'cancel-me' });
  
  const cancelCount = pool.cancel({ id: 'cancel-me' });
  assert.strictEqual(cancelCount, 1);
  await assert.rejects(p1, { message: 'Task cancelled via API' });
});