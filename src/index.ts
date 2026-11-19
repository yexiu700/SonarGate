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
    app.log.info({ signal }, 'Received shutdown signal; draining in-flight requests');

    const forceTimer = setTimeout(() => {
      app.log.error(
        { timeoutMs: SHUTDOWN_DRAIN_TIMEOUT_MS },
        'Graceful shutdown drain timed out; forcing exit',
      );
      process.exit(1);
    }, SHUTDOWN_DRAIN_TIMEOUT_MS);
    forceTimer.unref();

    try {
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
