import test from 'node:test';
import assert from 'node:assert';
import { EventEmitter } from 'node:events';
import leap from '../src/index.js';

test('LEAP should respect concurrency limits', async () => {
  const pool = leap(2);
  let active = 0;
  let maxActive = 0;

  const task = async () => {
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise(r => setTimeout(r, 10));
    active--;
  };

  await Promise.all([
    pool(task),
    pool(task),
    pool(task),
    pool(task)
  ]);
  
  assert.strictEqual(maxActive, 2, 'Should not exceed concurrency of 2');
});

test('High priority tasks should leap ahead in the queue', async () => {
  const pool = leap(1);
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
  const pool = leap(1);
  let attempts = 0;

  await pool(() => {
    attempts++;
    if (attempts < 3) throw new Error('Fail');
    return 'Success';
  }, { retryCount: 2, retryDelay: 10 });

  assert.strictEqual(attempts, 3, 'Should have attempted 3 times total');
});

test('Circuit Breaker should open on failures and block execution', async () => {
  const pool = leap(2, { 
    circuitThreshold: 3, 
    circuitResetTimeout: 100 
  });
  
  let executedAfterOpen = false;

  const failTask = () => Promise.reject(new Error('Persistent Failure'));
  await Promise.allSettled([pool(failTask), pool(failTask), pool(failTask)]);

  const p = pool(() => { executedAfterOpen = true; return 'Success'; });
  
  await new Promise(r => setTimeout(r, 50));
  assert.strictEqual(executedAfterOpen, false, 'Task should not execute while circuit is open');

  await new Promise(r => setTimeout(r, 150));
  await p;
  assert.strictEqual(executedAfterOpen, true, 'Task should execute after circuit resets');
});

test('Adaptive Concurrency should scale based on latency', async () => {
  const emitter = new EventEmitter();
  let adjustCount = 0;
  emitter.on('concurrency:adjust', () => adjustCount++);

  const pool = leap(1, { 
    adaptive: true, 
    minConcurrency: 1, 
    maxConcurrency: 5,
    emitter 
  });

  const fastTask = () => new Promise(r => setTimeout(() => r('fast'), 10));
  for(let i = 0; i < 11; i++) {
    await pool(fastTask);
  }

  assert.ok(pool.concurrency > 1, 'Concurrency should have increased');
  assert.ok(adjustCount > 0, 'Should have emitted adjust events');
});

test('Task Dependencies should execute in DAG order', async () => {
  const pool = leap(2);
  const results = [];

  const t1 = pool(() => results.push('A'), { id: 'taskA' });
  const t2 = pool(() => results.push('B'), { id: 'taskB', dependsOn: ['taskA'] });
  const t3 = pool(() => results.push('C'), { id: 'taskC', dependsOn: ['taskB'] });

  await Promise.all([t1, t2, t3]);
  assert.deepStrictEqual(results, ['A', 'B', 'C'], 'Tasks did not follow dependency order');
});

test('Priority Aging should prevent starvation', async () => {
  const pool = leap(1, { 
    agingThreshold: 1, 
    agingBoost: 10, 
    interval: 50 
  });
  
  const order = [];
  pool(() => new Promise(r => setTimeout(r, 100)));

  pool(() => order.push('low'), { priority: 0 });
  
  setTimeout(() => {
    pool(() => order.push('high'), { priority: 5 });
  }, 20);

  await new Promise(r => setTimeout(r, 150));
  await pool.onIdle();

  assert.strictEqual(order[0], 'low', 'Aging did not boost low priority task');
});

test('Weight-based concurrency should limit based on load', async () => {
  const pool = leap(10);
  let lightTaskExecuted = false;

  pool(async () => {
    await new Promise(r => setTimeout(r, 50));
  }, { weight: 10 });

  pool(() => { lightTaskExecuted = true; }, { weight: 1 });

  await new Promise(r => setTimeout(r, 20));
  assert.strictEqual(lightTaskExecuted, false, 'Light task should be blocked by heavy weight');
  
  await pool.onIdle();
  assert.strictEqual(lightTaskExecuted, true, 'Light task should eventually run');
});

test('Sub-queues (useQueue) should have isolated concurrency', async () => {
  const mainPool = leap(5);
  const cpuQueue = mainPool.useQueue('cpu', 1);
  const ioQueue = mainPool.useQueue('io', 10);

  let cpuActive = 0;
  const cpuTask = async () => {
    cpuActive++;
    await new Promise(r => setTimeout(r, 20));
    assert.ok(cpuActive <= 1, 'CPU queue exceeded its limit');
    cpuActive--;
  };

  await Promise.all([cpuQueue(cpuTask), cpuQueue(cpuTask)]);
});

test('maxQueueSize should reject tasks when the queue is full', async () => {
  const pool = leap(1, { maxQueueSize: 1 });
  
  const task1 = pool(() => new Promise(r => setTimeout(r, 50)));
  
  const task2 = pool(() => Promise.resolve('queued'));
  
  await assert.rejects(
    pool(() => Promise.resolve('rejected')),
    { message: 'Queue size limit exceeded' },
    'Should reject when queue limit is reached'
  );

  await pool.onIdle();
});

test('cancel should remove tasks from batch buffers', async () => {
  const pool = leap(2, { 
    batchSize: 10, 
    batchTimeout: 1000 
  });

  const p1 = pool(() => Promise.resolve(), { batchKey: 'b1', id: 'cancel-me' });
  const p2 = pool(() => Promise.resolve(), { batchKey: 'b1', id: 'keep-me' });

  const cancelledCount = pool.cancel({ id: 'cancel-me' });
  
  assert.strictEqual(cancelledCount, 1, 'Should report 1 task cancelled');
  await assert.rejects(p1, { message: 'Task cancelled via API' });
  
  pool.setConcurrency(2);
  await p2; 
});

test('cancel should remove tasks from blocked/dependency list', async () => {
  const pool = leap(1);
  
  pool(() => new Promise(r => setTimeout(r, 50)), { id: 'taskA' });
  
  const pB = pool(() => 'resultB', { id: 'taskB', dependsOn: ['taskA'] });
  
  assert.strictEqual(pool.pendingCount, 1, 'Task B should be in pending/blocked');
  
  const cancelledCount = pool.cancel({ id: 'taskB' });
  assert.strictEqual(cancelledCount, 1);
  
  await assert.rejects(pB, { message: 'Task cancelled via API' });
});

test('Adaptive concurrency should respect latency bounds (low latency)', async () => {
  const pool = leap(1, { 
    adaptive: true, 
    minConcurrency: 1, 
    maxConcurrency: 5 
  });

  const fastTask = () => new Promise(r => setTimeout(r, 10));
  
  for (let i = 0; i < 11; i++) {
    await pool(fastTask);
  }

  assert.ok(pool.concurrency > 1, `Concurrency (${pool.concurrency}) should increase for low latency`);
});

test('Adaptive concurrency should respect latency bounds (high latency)', async () => {
  const pool = leap(5, { 
    adaptive: true, 
    minConcurrency: 1, 
    maxConcurrency: 10 
  });

  const slowTask = () => new Promise(r => setTimeout(r, 210));
  
  const tasks = [];
  for (let i = 0; i < 11; i++) {
    tasks.push(pool(slowTask));
  }
  await Promise.all(tasks);

  assert.ok(pool.concurrency < 5, `Concurrency (${pool.concurrency}) should decrease for high latency`);
});