import { Queue } from "bullmq";

export const WORKER_HEARTBEAT_KEY = "answer-generation:worker:heartbeat";

export function redisConnection(redisUrl: string) {
  const url = new URL(redisUrl);
  return {
    host: url.hostname,
    port: Number(url.port || 6379),
    username: url.username || undefined,
    password: url.password || undefined,
    db: Number(url.pathname.replace("/", "") || 0)
  };
}

export async function isGenerationWorkerOnline() {
  if (!process.env.REDIS_URL) {
    return false;
  }

  const queue = new Queue("answer-generation", {
    connection: redisConnection(process.env.REDIS_URL)
  });

  try {
    const client = await queue.client;
    return Boolean(await client.get(WORKER_HEARTBEAT_KEY));
  } finally {
    await queue.close();
  }
}

export async function enqueueGenerationJob(jobId: string) {
  if (!process.env.REDIS_URL) {
    return { enqueued: false, workerOnline: false };
  }

  const queue = new Queue("answer-generation", {
    connection: redisConnection(process.env.REDIS_URL)
  });

  try {
    const client = await queue.client;
    const workerOnline = Boolean(await client.get(WORKER_HEARTBEAT_KEY));
    await queue.add("run-job", { jobId }, {
      attempts: 2,
      backoff: { type: "exponential", delay: 5000 },
      jobId: `answer-generation-${jobId}`,
      removeOnComplete: true,
      removeOnFail: 20
    });

    return { enqueued: true, workerOnline };
  } finally {
    await queue.close();
  }
}

export async function enqueueGenerationItem(jobId: string, itemId: string) {
  if (!process.env.REDIS_URL) {
    return { enqueued: false, workerOnline: false };
  }

  const queue = new Queue("answer-generation", {
    connection: redisConnection(process.env.REDIS_URL)
  });

  try {
    const client = await queue.client;
    const workerOnline = Boolean(await client.get(WORKER_HEARTBEAT_KEY));
    await queue.add("run-item", { jobId, itemId }, {
      attempts: 2,
      backoff: { type: "exponential", delay: 5000 },
      jobId: `answer-generation-${jobId}-item-${itemId}`,
      removeOnComplete: true,
      removeOnFail: 20
    });

    return { enqueued: true, workerOnline };
  } finally {
    await queue.close();
  }
}
