"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const HealthChecker_1 = require("../modules/HealthChecker");
const router = express_1.default.Router();
router.get('/', async (req, res) => {
    try {
        const forceRefresh = req.query.force === 'true';
        const report = await HealthChecker_1.healthChecker.getHealthReport(forceRefresh);
        res.json(report);
    }
    catch (error) {
        res.status(500).json({ error: error.message });
    }
});
router.post('/check', async (req, res) => {
    try {
        const report = await HealthChecker_1.healthChecker.triggerCheck();
        res.json(report);
    }
    catch (error) {
        res.status(500).json({ error: error.message });
    }
});
exports.default = router;
//# sourceMappingURL=health.js.map