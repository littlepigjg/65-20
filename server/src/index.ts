import express from 'express';
import cors from 'cors';
import { initStorage } from './utils/storage';
import configRouter from './routes/config';
import syncRouter from './routes/sync';
import conflictsRouter from './routes/conflicts';
import recordsRouter from './routes/records';
import healthRouter from './routes/health';
import { syncEngine } from './modules/SyncEngine';
import { healthChecker } from './modules/HealthChecker';

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

app.use('/api/config', configRouter);
app.use('/api/sync', syncRouter);
app.use('/api/conflicts', conflictsRouter);
app.use('/api/records', recordsRouter);
app.use('/api/health', healthRouter);

async function startServer() {
  try {
    await initStorage();
    console.log('[Storage] Initialized');

    app.listen(PORT, () => {
      console.log(`[Server] Running on http://localhost:${PORT}`);
    });

    await healthChecker.start();

    if (process.env.AUTO_START !== 'false') {
      await syncEngine.start();
    }
  } catch (error) {
    console.error('[Server] Failed to start:', error);
    process.exit(1);
  }
}

async function shutdown() {
  console.log('[Server] Shutting down...');
  try {
    await syncEngine.stop();
  } catch (e) {
    console.error('[Server] Error stopping sync engine:', e);
  }
  try {
    await healthChecker.stop();
  } catch (e) {
    console.error('[Server] Error stopping health checker:', e);
  }
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

startServer();
