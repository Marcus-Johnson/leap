import { Worker } from "node:worker_threads";
import { PriorityHeap } from "./heap.js";

export default function leap(initialConcurrency, globalOptions = {}) {
  const subQueues = new Map();
  const emitter = globalOptions.emitter ?? null;
  const emit = (event, data) => emitter?.emit?.(event, data);

  const { onEnqueue, onDequeue, beforeExecute, afterExecute } = globalOptions;

  const createPoolInstance = (concurrency, options) => {
    const queue = new PriorityHeap();
    const blockedTasks = new Map();
    const completedTasks = new Map();
    const pendingCache = new Map();
    const typeRateLimitState = new Map();
    const batchBuffers = new Map();
    const batchTimers = new Map();
    const workerPool = [];
    const activeWorkers = new Set();
    const rateLimitTimers = new Set();
    const abortListeners = new WeakMap();
    const workerWaitingQueue = [];

    let currentLoad = 0;
    let activeCount = 0;
    let currentConcurrency = concurrency;
    let isDraining = false;
    let isPaused = false;
    let seqCounter = 0;
    let idleResolver = null;
    let errorsInCycle = [];
    let circuitOpenUntil = 0;
    let consecutiveFailures = 0;
    let latencies = [];
    let minPriority = Infinity;
    let maxPriority = -Infinity;

    const config = {
      maxWorkerPoolSize: options.workerPoolSize ?? 0,
      circuitThreshold: options.circuitThreshold ?? 5,
      circuitResetTimeout: options.circuitResetTimeout ?? 30000,
      adaptive: options.adaptive ?? false,
      minC: options.minConcurrency ?? 1,
      maxC: options.maxConcurrency ?? concurrency * 2,
      completedTaskCleanupMs: options.completedTaskCleanupMs ?? 60000,
      batchSize: options.batchSize ?? 10,
      batchTimeout: options.batchTimeout ?? 100,
      initialRetryDelay: options.initialRetryDelay ?? 100,
      retryFactor: options.retryFactor ?? 2,
      maxRetryDelay: options.maxRetryDelay ?? 10000,
      maintenanceInterval: options.interval ?? 1000,
      maxLatencyHistory: options.maxLatencyHistory ?? 10000,
    };

    const metrics = {
      totalTasks: 0,
      successfulTasks: 0,
      failedTasks: 0,
      startTime: Date.now(),
      allLatencies: [],
      get isCircuitOpen() {
        return Date.now() < circuitOpenUntil;
      },
      get throughput() {
        const elapsedSec = (Date.now() - this.startTime) / 1000;
        return elapsedSec > 0
          ? (this.successfulTasks / elapsedSec).toFixed(2)
          : 0;
      },
      get errorRate() {
        return this.totalTasks > 0
          ? (this.failedTasks / this.totalTasks).toFixed(4)
          : 0;
      },
      get percentiles() {
        if (this.allLatencies.length === 0) return { p50: 0, p90: 0, p99: 0 };
        const sorted = [...this.allLatencies].sort((a, b) => a - b);
        const getP = (p) =>
          sorted[Math.floor((p / 100) * (sorted.length - 1))].toFixed(2);
        return { p50: getP(50), p90: getP(90), p99: getP(99) };
      },
    };

    const maintenanceInterval = setInterval(() => {
      if (options.agingThreshold && queue.size() > 0) {
        queue.adjustPriorities(
          options.agingThreshold,
          options.agingBoost || 1,
          false
        );
        updatePriorityBounds();
      }
      if (options.decayThreshold && queue.size() > 0) {
        queue.adjustPriorities(
          options.decayThreshold,
          options.decayAmount || 1,
          true
        );
        updatePriorityBounds();
      }

      const cutoff = Date.now() - config.completedTaskCleanupMs;
      const toDelete = [];
      for (const [id, time] of completedTasks.entries()) {
        if (time < cutoff) {
          const hasBlockedDeps = Array.from(blockedTasks.values()).some(
            (tasks) => tasks.some((t) => t.dependsOn?.includes(id))
          );
          if (!hasBlockedDeps) toDelete.push(id);
        }
      }
      toDelete.forEach((id) => completedTasks.delete(id));

      if (Date.now() >= circuitOpenUntil && circuitOpenUntil > 0) {
        consecutiveFailures = 0;
        circuitOpenUntil = 0;
        emit("circuit:closed", {});
      }

      next();
    }, config.maintenanceInterval);

    const updatePriorityBounds = () => {
      if (queue.size() === 0) {
        minPriority = Infinity;
        maxPriority = -Infinity;
        return;
      }
      minPriority = Infinity;
      maxPriority = -Infinity;
      for (let i = 0; i < queue.heap.length; i++) {
        const p = queue.heap[i].priority;
        if (p < minPriority) minPriority = p;
        if (p > maxPriority) maxPriority = p;
      }
    };

    const adjustConcurrency = () => {
      if (!config.adaptive || latencies.length < 10) return;
      const avg = latencies.reduce((a, b) => a + b, 0) / latencies.length;
      latencies = [];

      if (avg < 50 && currentConcurrency < config.maxC) {
        currentConcurrency++;
        emit("concurrency:adjust", {
          concurrency: currentConcurrency,
          reason: "low_latency",
        });
      } else if (avg > 200 && currentConcurrency > config.minC) {
        currentConcurrency--;
        emit("concurrency:adjust", {
          concurrency: currentConcurrency,
          reason: "high_latency",
        });
      }
    };

    const checkRateLimit = (type) => {
      const taskType = type || "default";
      const limit =
        options.rateLimits?.[taskType] ||
        (options.tasksPerInterval
          ? {
              interval: config.maintenanceInterval,
              tasksPerInterval: options.tasksPerInterval,
            }
          : null);

      if (!limit) return true;

      let state = typeRateLimitState.get(taskType);
      if (!state) {
        state = { lastWindowStart: Date.now(), tasksInWindow: 0 };
        typeRateLimitState.set(taskType, state);
      }

      const now = Date.now();
      if (now - state.lastWindowStart > limit.interval) {
        state.lastWindowStart = now;
        state.tasksInWindow = 0;
      }

      if (state.tasksInWindow >= limit.tasksPerInterval) {
        const delay = limit.interval - (now - state.lastWindowStart);
        const timerId = setTimeout(() => {
          rateLimitTimers.delete(timerId);
          next();
        }, delay);
        rateLimitTimers.add(timerId);
        return false;
      }

      state.tasksInWindow++;
      return true;
    };

    const next = () => {
      if (isPaused) return;

      const now = Date.now();
      if (now < circuitOpenUntil) {
        const delay = Math.max(circuitOpenUntil - now, 1000);
        const timerId = setTimeout(() => {
          rateLimitTimers.delete(timerId);
          next();
        }, delay);
        rateLimitTimers.add(timerId);
        return;
      }

      while (queue.size() > 0) {
        const itemToProcess = queue.peek();
        const weight = itemToProcess.weight || 1;

        if (currentLoad + weight > currentConcurrency && activeCount > 0) break;

        if (!checkRateLimit(itemToProcess.type)) break;

        const item = queue.pop();
        updatePriorityBounds();
        onDequeue?.(item);
        executeTask(item, weight);
      }

      checkIdle();
    };

    const checkIdle = () => {
      if (
        activeCount === 0 &&
        queue.size() === 0 &&
        blockedTasks.size === 0 &&
        batchBuffers.size === 0
      ) {
        if (idleResolver) {
          const result = {
            errors: [...errorsInCycle],
            failed: errorsInCycle.length > 0,
            metrics,
          };
          errorsInCycle = [];
          idleResolver(result);
          idleResolver = null;
        }
      }
    };

    const executeTask = async (item, weight) => {
      const {
        task,
        resolve,
        reject,
        signal,
        timeout,
        deadline,
        id,
        cacheKey,
        workerConfig,
        retryCount,
        initialRetryCount = retryCount,
      } = item;

      if ((deadline && Date.now() > deadline) || signal?.aborted) {
        reject(
          signal?.aborted
            ? signal.reason || new Error("Aborted")
            : new Error("Task deadline exceeded")
        );
        return next();
      }

      if (signal && !abortListeners.has(signal)) {
        const abortHandler = () => {
          if (item.isActive) {
            reject(signal.reason || new Error("Aborted"));
            item.isActive = false;
          }
        };
        signal.addEventListener("abort", abortHandler);
        abortListeners.set(signal, abortHandler);
      }

      item.isActive = true;
      activeCount++;
      currentLoad += weight;
      const memBefore = process.memoryUsage().heapUsed;
      const profilerStart = performance.now();
      beforeExecute?.(item);

      let timeoutId;
      try {
        let result;
        if (workerConfig) {
          result = await handleWorkerTask(workerConfig);
        } else {
          const promises = [task()];
          if (timeout > 0) {
            promises.push(
              new Promise((_, rej) => {
                timeoutId = setTimeout(
                  () => rej(new Error("Task Timeout")),
                  timeout
                );
              })
            );
          }
          result = await Promise.race(promises);
        }

        if (!item.isActive) return;

        consecutiveFailures = 0;
        if (id) {
          completedTasks.set(id, Date.now());
          const waiting = blockedTasks.get(id) || [];
          blockedTasks.delete(id);
          waiting.forEach((t) => checkDependencies(t));
        }

        const duration = performance.now() - profilerStart;
        latencies.push(duration);
        if (latencies.length > 100) latencies.shift();

        metrics.allLatencies.push(duration);
        if (metrics.allLatencies.length > config.maxLatencyHistory) {
          metrics.allLatencies.shift();
        }

        adjustConcurrency();
        metrics.successfulTasks++;
        afterExecute?.(item, {
          duration,
          memoryDelta: process.memoryUsage().heapUsed - memBefore,
          status: "success",
        });
        resolve(result);
      } catch (error) {
        if (!item.isActive) return;

        consecutiveFailures++;
        metrics.failedTasks++;
        if (consecutiveFailures >= config.circuitThreshold) {
          circuitOpenUntil = Date.now() + config.circuitResetTimeout;
          emit("circuit:open", { until: circuitOpenUntil });
        }

        if (
          retryCount > 0 &&
          !signal?.aborted &&
          error.message !== "Task Timeout"
        ) {
          handleRetry(item, initialRetryCount);
          return;
        }

        errorsInCycle.push(error);
        afterExecute?.(item, {
          duration: performance.now() - profilerStart,
          status: "error",
          error: error.message,
        });
        reject(error);
      } finally {
        item.isActive = false;
        if (cacheKey) pendingCache.delete(cacheKey);
        if (timeoutId) clearTimeout(timeoutId);
        metrics.totalTasks++;
        activeCount--;
        currentLoad -= weight;
        next();
      }
    };

    const handleWorkerTask = async (workerConfig) => {
      let workerInstance = getWorker(workerConfig.path);

      if (!workerInstance) {
        workerInstance = await new Promise((resolve) => {
          workerWaitingQueue.push({ path: workerConfig.path, resolve });
        });
      }

      activeWorkers.add(workerInstance);
      return new Promise((res, rej) => {
        workerInstance.once("message", res);
        workerInstance.once("error", rej);
        workerInstance.postMessage(workerConfig.data);
      }).finally(() => {
        activeWorkers.delete(workerInstance);
        releaseWorker(workerInstance);
      });
    };

    const handleRetry = (item, initialRetryCount) => {
      const currentAttempt = initialRetryCount - item.retryCount + 1;
      const backoffDelay =
        config.initialRetryDelay * Math.pow(config.retryFactor, currentAttempt);
      const jitteredDelay =
        Math.min(backoffDelay, config.maxRetryDelay) *
        (1 + Math.random() * 0.1);

      setTimeout(() => {
        queue.push({ ...item, retryCount: item.retryCount - 1 });
        updatePriorityBounds();
        next();
      }, jitteredDelay);
    };

    const checkDependencies = (taskData) => {
      const remaining = taskData.dependsOn.filter(
        (depId) => !completedTasks.has(depId)
      );
      if (remaining.length === 0) {
        queue.push(taskData);
        updatePriorityBounds();
        next();
      } else {
        remaining.forEach((depId) => {
          if (!blockedTasks.has(depId)) blockedTasks.set(depId, []);
          blockedTasks.get(depId).push(taskData);
        });
      }
    };

    const getWorker = (path) => {
      let entry = workerPool.find((w) => w.path === path && !w.busy);
      if (
        !entry &&
        (config.maxWorkerPoolSize <= 0 ||
          workerPool.length < config.maxWorkerPoolSize)
      ) {
        const worker = new Worker(path);
        entry = { worker, path, busy: true };
        workerPool.push(entry);
        return entry.worker;
      }
      if (entry) {
        entry.busy = true;
        return entry.worker;
      }
      return null;
    };

    const releaseWorker = (worker) => {
      const entry = workerPool.find((w) => w.worker === worker);
      if (entry) {
        entry.busy = false;

        const nextInLineIndex = workerWaitingQueue.findIndex(
          (q) => q.path === entry.path
        );
        if (nextInLineIndex !== -1) {
          const { resolve } = workerWaitingQueue.splice(nextInLineIndex, 1)[0];
          entry.busy = true;
          resolve(entry.worker);
        }
      }
    };

    const flushBatch = (batchKey) => {
      const buffer = batchBuffers.get(batchKey);
      if (!buffer || buffer.length === 0) return;

      batchBuffers.delete(batchKey);
      if (batchTimers.has(batchKey)) {
        clearTimeout(batchTimers.get(batchKey));
        batchTimers.delete(batchKey);
      }

      const metaTask = async () => {
        const results = await Promise.allSettled(buffer.map((t) => t.task()));
        results.forEach((res, i) => {
          if (res.status === "fulfilled") buffer[i].resolve(res.value);
          else buffer[i].reject(res.reason);
        });
      };

      let maxPrio = buffer[0].priority;
      for (let i = 1; i < buffer.length; i++) {
        if (buffer[i].priority > maxPrio) maxPrio = buffer[i].priority;
      }

      queue.push({
        task: metaTask,
        priority: maxPrio,
        weight: 1,
        type: buffer[0].type,
        seq: seqCounter++,
      });
      updatePriorityBounds();
      next();
    };

    const poolInstance = (task, optionsParam = {}) => {
      if (isDraining) return Promise.reject(new Error("Pool is draining"));
      if (queue.size() >= (options.maxQueueSize ?? Infinity))
        return Promise.reject(new Error("Queue size limit exceeded"));

      const opts =
        typeof optionsParam === "number"
          ? { priority: optionsParam }
          : optionsParam;
      if (opts.cacheKey && pendingCache.has(opts.cacheKey))
        return pendingCache.get(opts.cacheKey);

      const taskPromise = new Promise((resolve, reject) => {
        const taskData = {
          task,
          resolve,
          reject,
          seq: seqCounter++,
          priority: opts.priority ?? 0,
          weight: opts.weight ?? 1,
          dependsOn: opts.dependsOn || [],
          cycles: 0,
          isActive: false,
          ...opts,
        };
        onEnqueue?.(taskData);

        if (opts.batchKey) {
          if (!batchBuffers.has(opts.batchKey))
            batchBuffers.set(opts.batchKey, []);
          const buffer = batchBuffers.get(opts.batchKey);
          buffer.push(taskData);
          if (buffer.length >= config.batchSize) {
            flushBatch(opts.batchKey);
          } else if (!batchTimers.has(opts.batchKey)) {
            batchTimers.set(
              opts.batchKey,
              setTimeout(() => flushBatch(opts.batchKey), config.batchTimeout)
            );
          }
        } else if (taskData.dependsOn.length > 0) {
          checkDependencies(taskData);
        } else {
          queue.push(taskData);
          updatePriorityBounds();
          next();
        }
      });

      if (opts.cacheKey) pendingCache.set(opts.cacheKey, taskPromise);
      return taskPromise;
    };

    poolInstance.pause = () => {
      isPaused = true;
    };
    poolInstance.resume = () => {
      isPaused = false;
      next();
    };
    poolInstance.onIdle = () => {
      for (const key of batchBuffers.keys()) flushBatch(key);
      return new Promise((r) =>
        activeCount === 0 &&
        queue.size() === 0 &&
        blockedTasks.size === 0 &&
        batchBuffers.size === 0
          ? r({ errors: [], failed: false, metrics })
          : (idleResolver = r)
      );
    };
    poolInstance.drain = () => {
      isDraining = true;
      return poolInstance.onIdle();
    };

    poolInstance.cancel = (query) => {
      const match =
        typeof query === "function"
          ? query
          : (t) =>
              (query.id && t.id === query.id) ||
              (query.tag && t.tags?.includes(query.tag));
      let count = 0;

      queue.remove((t) => {
        if (match(t)) {
          if (t.cacheKey) pendingCache.delete(t.cacheKey);
          t.reject(new Error("Task cancelled via API"));
          count++;
          return true;
        }
        return false;
      });

      for (const [batchKey, buffer] of batchBuffers.entries()) {
        const initialLen = buffer.length;
        const filtered = buffer.filter((task) => {
          if (match(task)) {
            if (task.cacheKey) pendingCache.delete(task.cacheKey);
            task.reject(new Error("Task cancelled via API"));
            count++;
            return false;
          }
          return true;
        });

        if (filtered.length === 0) {
          batchBuffers.delete(batchKey);
          if (batchTimers.has(batchKey)) {
            clearTimeout(batchTimers.get(batchKey));
            batchTimers.delete(batchKey);
          }
        } else if (filtered.length !== initialLen) {
          batchBuffers.set(batchKey, filtered);
        }
      }

      const cancelledInBlocked = new Set();
      for (const [depId, tasks] of blockedTasks.entries()) {
        const initialLen = tasks.length;
        const filtered = tasks.filter((task) => {
          if (match(task)) {
            if (!cancelledInBlocked.has(task)) {
              if (task.cacheKey) pendingCache.delete(task.cacheKey);
              task.reject(new Error("Task cancelled via API"));
              count++;
              cancelledInBlocked.add(task);
            }
            return false;
          }
          return true;
        });

        if (filtered.length === 0) {
          blockedTasks.delete(depId);
        } else if (filtered.length !== initialLen) {
          blockedTasks.set(depId, filtered);
        }
      }

      if (count > 0) updatePriorityBounds();
      return count;
    };

    poolInstance.setConcurrency = (limit) => {
      currentConcurrency = limit;
      next();
    };

    poolInstance.peek = () => {
      return queue.peek();
    };

    poolInstance.remove = (predicate) => {
      const result = queue.remove(predicate);
      if (result) updatePriorityBounds();
      return result;
    };

    poolInstance.clear = () => {
      clearInterval(maintenanceInterval);
      rateLimitTimers.forEach(clearTimeout);
      rateLimitTimers.clear();
      queue.clear();
      blockedTasks.clear();
      completedTasks.clear();
      pendingCache.clear();
      batchBuffers.clear();
      batchTimers.forEach(clearTimeout);
      batchTimers.clear();
      workerPool.forEach((w) => w.worker.terminate());
      workerPool.length = 0;
      activeWorkers.clear();
      workerWaitingQueue.length = 0;

      if (poolInstance.useQueue) {
        for (const sub of subQueues.values()) {
          sub.clear();
        }
        subQueues.clear();
      }
    };

    poolInstance.map = async (items, fn, opts) => {
      const results = [];
      for (const item of items) {
        results.push(poolInstance(() => fn(item), opts));
      }
      return Promise.all(results);
    };

    Object.defineProperties(poolInstance, {
      activeCount: { get: () => activeCount },
      pendingCount: { get: () => queue.size() + blockedTasks.size },
      currentLoad: { get: () => currentLoad },
      concurrency: { get: () => currentConcurrency },
      isDraining: { get: () => isDraining },
      isPaused: { get: () => isPaused },
      metrics: { get: () => metrics },
    });

    return poolInstance;
  };

  const mainPool = createPoolInstance(initialConcurrency, globalOptions);
  mainPool.useQueue = (name, concurrency = initialConcurrency) => {
    if (!subQueues.has(name))
      subQueues.set(name, createPoolInstance(concurrency, globalOptions));
    return subQueues.get(name);
  };

  return mainPool;
}
