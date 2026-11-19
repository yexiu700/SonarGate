import { setTimeout as sleep } from 'node:timers/promises';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';

const SHUTDOWN_DRAIN_TIMEOUT_MS = 30_000;

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const app = buildApp({ config });

  let shuttingDown = false;

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;

    app.markShuttingDown();
    const graceMs = config.server.shutdownGraceMs;
    app.log.info(
      { signal, graceMs },
      'Received shutdown signal; /ready now returns 503, waiting for load balancer to drain',
    );

    const forceTimeoutMs = graceMs + SHUTDOWN_DRAIN_TIMEOUT_MS;
    const forceTimer = setTimeout(() => {
      app.log.error({ timeoutMs: forceTimeoutMs }, 'Graceful shutdown timed out; forcing exit');
      process.exit(1);
    }, forceTimeoutMs);
    forceTimer.unref();

    try {
      if (graceMs > 0) {
        await sleep(graceMs);
      }
      app.log.info('Closing listener and draining in-flight requests');
      await app.close();
      clearTimeout(forceTimer);
      app.log.info('SonarGate server closed cleanly');
      process.exit(0);
    } catch (err) {
      clearTimeout(forceTimer);
      app.log.error({ err }, 'Error during graceful shutdown');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
  process.on('SIGINT', () => {
    void shutdown('SIGINT');
  });

  await app.listen({
    host: config.server.host,
    port: config.server.port,
  });

  app.log.info(
    {
      host: config.server.host,
      port: config.server.port,
      nodeEnv: config.server.nodeEnv,
    },
    'SonarGate gateway listening',
  );
}

main().catch((err: unknown) => {
  console.error('Failed to start SonarGate:', err);
  process.exit(1);
});
