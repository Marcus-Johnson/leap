import test from "node:test";
import assert from "node:assert";
import leap from "../src/index.js";

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

test("Core: should respect strict concurrency limits", async () => {
  const pool = leap(3);
  try {
    let active = 0;
    let maxActive = 0;

    const task = async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await delay(20);
      active--;
    };

    await Promise.all(Array.from({ length: 10 }, () => pool(task)));
    assert.strictEqual(maxActive, 3, "Should never exceed concurrency of 3");
  } finally {
    await pool.clear();
  }
});

test("Core: should manage load via task weights", async () => {
  const pool = leap(10);
  try {
    let ran = false;
    pool(() => delay(50), { weight: 10 });

    const p2 = pool(
      () => {
        ran = true;
      },
      { weight: 1 }
    );

    await delay(20);
    assert.strictEqual(ran, false, "Weighted task should be blocked");

    await p2;
    assert.strictEqual(ran, true);
  } finally {
    await pool.clear();
  }
});

test("Core: should resolve onIdle when all work is finished", async () => {
  const pool = leap(2);
  try {
    let count = 0;
    for (let i = 0; i < 5; i++) {
      pool(async () => {
        await delay(10);
        count++;
      });
    }

    const result = await pool.onIdle();
    assert.strictEqual(count, 5);
    assert.strictEqual(result.failed, false);
  } finally {
    await pool.clear();
  }
});

test("Priority: should execute tasks in priority order (Max-Heap)", async () => {
  const pool = leap(1);
  try {
    const order = [];
    pool(() => delay(30));

    pool(() => order.push("low"), { priority: 0 });
    pool(() => order.push("high"), { priority: 100 });
    pool(() => order.push("mid"), { priority: 50 });

    await pool.onIdle();
    assert.deepStrictEqual(order, ["high", "mid", "low"]);
  } finally {
    await pool.clear();
  }
});

test("Priority: should prevent starvation via aging boost", async () => {
  const pool = leap(1, {
    agingThreshold: 1,
    agingBoost: 20,
    interval: 20,
  });
  try {
    const order = [];
    pool(() => delay(60));

    pool(() => order.push("starved"), { priority: 0 });
    await delay(10);
    pool(() => order.push("new-high"), { priority: 10 });

    await pool.onIdle();
    assert.strictEqual(order[0], "starved");
  } finally {
    await pool.clear();
  }
});

test("Resilience: should retry failed tasks with exponential backoff", async () => {
  const pool = leap(1, {
    retryCount: 3,
    initialRetryDelay: 10,
    retryFactor: 2,
  });
  try {
    let attempts = 0;
    const result = await pool(() => {
      attempts++;
      if (attempts < 3) throw new Error("Temp Fail");
      return "OK";
    });

    assert.strictEqual(result, "OK");
    assert.strictEqual(attempts, 3);
  } finally {
    await pool.clear();
  }
});

test("Resilience: should trip circuit breaker on repeated failures", async () => {
  const pool = leap(1, {
    circuitThreshold: 2,
    circuitResetTimeout: 50,
  });
  try {
    const fail = () => Promise.reject(new Error("Fail"));
    await Promise.allSettled([pool(fail), pool(fail)]);

    await assert.rejects(
      pool(() => "should not run"),
      /Circuit breaker open/
    );

    await delay(60);
    const success = await pool(() => "recovered");
    assert.strictEqual(success, "recovered");
  } finally {
    await pool.clear();
  }
});

test("Advanced: should respect task dependencies (DAG)", async () => {
  const pool = leap(2);
  try {
    const log = [];
    const t1 = pool(() => log.push("A"), { id: "A" });
    const t3 = pool(() => log.push("C"), { id: "C", dependsOn: ["B"] });
    const t2 = pool(() => log.push("B"), { id: "B", dependsOn: ["A"] });

    await Promise.all([t1, t2, t3]);
    assert.deepStrictEqual(log, ["A", "B", "C"]);
  } finally {
    await pool.clear();
  }
});

test("Advanced: should batch tasks by key", async () => {
  const pool = leap(5, { batchSize: 3, batchTimeout: 1000 });
  try {
    let execCount = 0;
    const task = () => {
      execCount++;
      return Promise.resolve();
    };

    const p1 = pool(task, { batchKey: "b1" });
    const p2 = pool(task, { batchKey: "b1" });
    const p3 = pool(task, { batchKey: "b1" });

    await Promise.all([p1, p2, p3]);
    assert.strictEqual(execCount, 3);
  } finally {
    await pool.clear();
  }
});

test("Advanced: should enforce rate limits per type", async () => {
  const pool = leap(5, {
    rateLimits: { api: { interval: 100, tasksPerInterval: 2 } },
  });
  try {
    const start = Date.now();
    const tasks = Array.from({ length: 3 }, () =>
      pool(() => Promise.resolve(), { type: "api" })
    );

    await Promise.all(tasks);
    const duration = Date.now() - start;
    assert.ok(duration >= 100, `Rate limit ignored: took ${duration}ms`);
  } finally {
    await pool.clear();
  }
});

test("Lifecycle: should deduplicate work via cacheKey", async () => {
  const pool = leap(1);
  try {
    let calls = 0;
    const sharedTask = async () => {
      calls++;
      await delay(20);
      return "data";
    };

    const [r1, r2] = await Promise.all([
      pool(sharedTask, { cacheKey: "fetch-1" }),
      pool(sharedTask, { cacheKey: "fetch-1" }),
    ]);

    assert.strictEqual(calls, 1, "Task should only execute once");
    assert.strictEqual(r1, r2);
  } finally {
    await pool.clear();
  }
});

test("Lifecycle: should cancel tasks by ID or Tag", async () => {
  const pool = leap(1);
  try {
    pool(() => delay(50));
    const p1 = pool(() => "never", { id: "cancel-me" });
    const p2 = pool(() => "never", { tags: ["cleanup"] });

    const cancelled = pool.cancel({ id: "cancel-me" });
    const cancelledTag = pool.cancel({ tag: "cleanup" });

    assert.strictEqual(cancelled, 1);
    assert.strictEqual(cancelledTag, 1);
    await assert.rejects(p1, /Task cancelled/);
    await assert.rejects(p2, /Task cancelled/);
  } finally {
    await pool.clear();
  }
});

test("Lifecycle: should clear all resources and terminate workers", async () => {
  const pool = leap(1);
  pool(() => delay(100));
  pool(() => "pending");

  assert.strictEqual(pool.pendingCount, 1);

  await pool.clear();
  assert.strictEqual(pool.pendingCount, 0);
  assert.strictEqual(pool.activeCount, 0);
});

test("Observability: should trigger afterExecute profile hooks", async () => {
  let profileResult = null;
  const pool = leap(1, {
    afterExecute: (task, profile) => {
      profileResult = profile;
    },
  });
  try {
    await pool(() => delay(20));
    assert.ok(profileResult.duration >= 20);
    assert.strictEqual(profileResult.status, "success");
    assert.ok(profileResult.memoryDelta !== undefined);
  } finally {
    await pool.clear();
  }
});

test("Observability: should calculate correct latency percentiles", async () => {
  const pool = leap(1);
  try {
    await pool(() => delay(10));
    await pool(() => delay(30));

    const { p50, p99 } = pool.metrics.percentiles;
    
    assert.ok(parseFloat(p50) >= 8, `Expected p50 >= 8, got ${p50}`); 
    assert.ok(parseFloat(p99) >= 25, `Expected p99 >= 25, got ${p99}`);
  } finally {
    await pool.clear();
  }
});
