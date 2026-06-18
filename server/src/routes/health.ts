import express from 'express';
import { healthChecker } from '../modules/HealthChecker';

const router = express.Router();

router.get('/', async (req, res) => {
  try {
    const forceRefresh = req.query.force === 'true';
    const report = await healthChecker.getHealthReport(forceRefresh);
    res.json(report);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/check', async (req, res) => {
  try {
    const report = await healthChecker.triggerCheck();
    res.json(report);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
