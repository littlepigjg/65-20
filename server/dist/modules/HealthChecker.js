"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.healthChecker = exports.HealthChecker = void 0;
const fs_extra_1 = __importDefault(require("fs-extra"));
const path_1 = __importDefault(require("path"));
const events_1 = require("events");
const child_process_1 = require("child_process");
const storage_1 = require("../utils/storage");
const FileWatcher_1 = require("./FileWatcher");
const ConflictDetector_1 = require("./ConflictDetector");
const CHECK_INTERVAL_MS = 5 * 60 * 1000;
const CACHE_TTL_MS = 30 * 1000;
const DISK_SPACE_WARNING_THRESHOLD = 0.1;
const MEMORY_WARNING_THRESHOLD_MB = 500;
const CONFLICT_WARNING_THRESHOLD = 100;
const BLOCKING_CHECKS = ['sourceDirAccess', 'targetDirAccess', 'diskSpace', 'writePermission'];
class HealthChecker extends events_1.EventEmitter {
    constructor() {
        super(...arguments);
        this.timer = null;
        this.cache = null;
        this.isRunning = false;
        this.isChecking = false;
    }
    async start() {
        if (this.isRunning)
            return;
        this.isRunning = true;
        console.log('[HealthChecker] Starting health check system...');
        await this.performCheck();
        this.timer = setInterval(() => {
            this.performCheck().catch(error => {
                console.error('[HealthChecker] Scheduled check failed:', error);
            });
        }, CHECK_INTERVAL_MS);
        this.timer.unref();
        console.log('[HealthChecker] Started, check interval: 5 minutes');
    }
    async stop() {
        if (!this.isRunning)
            return;
        this.isRunning = false;
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
        this.cache = null;
        console.log('[HealthChecker] Stopped');
    }
    async getHealthReport(forceRefresh = false) {
        if (!forceRefresh && this.cache && Date.now() - this.cache.cachedAt < CACHE_TTL_MS) {
            return this.cache.result;
        }
        if (this.isChecking) {
            if (this.cache) {
                return this.cache.result;
            }
            await this.waitForCheck();
            return this.cache.result;
        }
        return await this.performCheck();
    }
    isSyncBlocked() {
        if (!this.cache)
            return false;
        return this.cache.result.syncBlocked;
    }
    getBlockingReasons() {
        if (!this.cache)
            return [];
        return this.cache.result.blockingReasons;
    }
    async triggerCheck() {
        console.log('[HealthChecker] Manual check triggered');
        return await this.performCheck();
    }
    async waitForCheck() {
        return new Promise(resolve => {
            const checkInterval = setInterval(() => {
                if (!this.isChecking) {
                    clearInterval(checkInterval);
                    resolve();
                }
            }, 100);
        });
    }
    async performCheck() {
        if (this.isChecking) {
            return this.cache ? this.cache.result : this.createEmptyReport();
        }
        this.isChecking = true;
        try {
            const config = await (0, storage_1.getConfig)();
            const checks = [];
            checks.push(await this.checkSourceDirAccess(config.sourceDir));
            checks.push(await this.checkTargetDirAccess(config.targetDir));
            checks.push(await this.checkDiskSpace(config.sourceDir, config.targetDir));
            checks.push(await this.checkWritePermission(config.sourceDir, config.targetDir));
            checks.push(await this.checkFileWatcher());
            checks.push(await this.checkMemoryUsage());
            checks.push(await this.checkConflictCount());
            const overallStatus = this.calculateOverallStatus(checks);
            const blockingReasons = this.getBlockingReasonsFromChecks(checks);
            const syncBlocked = blockingReasons.length > 0;
            const report = {
                overallStatus,
                checks,
                lastCheckedAt: Date.now(),
                syncBlocked,
                blockingReasons
            };
            this.cache = {
                result: report,
                cachedAt: Date.now()
            };
            this.logReport(report);
            this.emit('healthChange', report);
            return report;
        }
        catch (error) {
            console.error('[HealthChecker] Check failed:', error);
            const report = this.createErrorReport(error.message);
            this.cache = { result: report, cachedAt: Date.now() };
            return report;
        }
        finally {
            this.isChecking = false;
        }
    }
    async checkSourceDirAccess(sourceDir) {
        const now = Date.now();
        try {
            const exists = await fs_extra_1.default.pathExists(sourceDir);
            if (!exists) {
                return {
                    type: 'sourceDirAccess',
                    status: 'critical',
                    message: `源目录不存在: ${sourceDir}`,
                    details: { path: sourceDir },
                    checkedAt: now
                };
            }
            const stat = await fs_extra_1.default.stat(sourceDir);
            if (!stat.isDirectory()) {
                return {
                    type: 'sourceDirAccess',
                    status: 'critical',
                    message: `源路径不是目录: ${sourceDir}`,
                    details: { path: sourceDir },
                    checkedAt: now
                };
            }
            await fs_extra_1.default.access(sourceDir, fs_extra_1.default.constants.R_OK);
            return {
                type: 'sourceDirAccess',
                status: 'healthy',
                message: '源目录可正常访问',
                details: { path: sourceDir },
                checkedAt: now
            };
        }
        catch (error) {
            return {
                type: 'sourceDirAccess',
                status: 'critical',
                message: `源目录访问失败: ${error.message}`,
                details: { path: sourceDir, error: error.message },
                checkedAt: now
            };
        }
    }
    async checkTargetDirAccess(targetDir) {
        const now = Date.now();
        try {
            const exists = await fs_extra_1.default.pathExists(targetDir);
            if (!exists) {
                return {
                    type: 'targetDirAccess',
                    status: 'critical',
                    message: `目标目录不存在: ${targetDir}`,
                    details: { path: targetDir },
                    checkedAt: now
                };
            }
            const stat = await fs_extra_1.default.stat(targetDir);
            if (!stat.isDirectory()) {
                return {
                    type: 'targetDirAccess',
                    status: 'critical',
                    message: `目标路径不是目录: ${targetDir}`,
                    details: { path: targetDir },
                    checkedAt: now
                };
            }
            await fs_extra_1.default.access(targetDir, fs_extra_1.default.constants.R_OK);
            return {
                type: 'targetDirAccess',
                status: 'healthy',
                message: '目标目录可正常访问',
                details: { path: targetDir },
                checkedAt: now
            };
        }
        catch (error) {
            return {
                type: 'targetDirAccess',
                status: 'critical',
                message: `目标目录访问失败: ${error.message}`,
                details: { path: targetDir, error: error.message },
                checkedAt: now
            };
        }
    }
    async checkDiskSpace(sourceDir, targetDir) {
        const now = Date.now();
        try {
            const sourceDrive = this.getDrivePath(sourceDir);
            const targetDrive = this.getDrivePath(targetDir);
            const sourceSpace = await this.getDiskSpace(sourceDir);
            const targetSpace = sourceDrive === targetDrive
                ? sourceSpace
                : await this.getDiskSpace(targetDir);
            const sourceFreePercent = sourceSpace.freeBytes / sourceSpace.totalBytes;
            const targetFreePercent = targetSpace.freeBytes / targetSpace.totalBytes;
            const minFreePercent = Math.min(sourceFreePercent, targetFreePercent);
            const minDrive = sourceFreePercent <= targetFreePercent ? '源目录' : '目标目录';
            let status = 'healthy';
            let message = '磁盘空间充足';
            if (minFreePercent < DISK_SPACE_WARNING_THRESHOLD) {
                status = 'critical';
                message = `${minDrive}磁盘空间不足，剩余 ${(minFreePercent * 100).toFixed(1)}%（低于 10% 阈值）`;
            }
            else if (minFreePercent < DISK_SPACE_WARNING_THRESHOLD * 2) {
                status = 'warning';
                message = `${minDrive}磁盘空间偏低，剩余 ${(minFreePercent * 100).toFixed(1)}%`;
            }
            return {
                type: 'diskSpace',
                status,
                message,
                details: {
                    source: {
                        drive: sourceDrive,
                        totalBytes: sourceSpace.totalBytes,
                        freeBytes: sourceSpace.freeBytes,
                        freePercent: +(sourceFreePercent * 100).toFixed(2)
                    },
                    target: {
                        drive: targetDrive,
                        totalBytes: targetSpace.totalBytes,
                        freeBytes: targetSpace.freeBytes,
                        freePercent: +(targetFreePercent * 100).toFixed(2)
                    },
                    thresholdPercent: DISK_SPACE_WARNING_THRESHOLD * 100
                },
                checkedAt: now
            };
        }
        catch (error) {
            return {
                type: 'diskSpace',
                status: 'warning',
                message: `磁盘空间检查失败: ${error.message}`,
                details: { error: error.message },
                checkedAt: now
            };
        }
    }
    getDrivePath(dirPath) {
        if (process.platform === 'win32') {
            const match = dirPath.match(/^([a-zA-Z]:)/);
            return match ? match[1] : 'C:';
        }
        return '/';
    }
    async getDiskSpace(dirPath) {
        if (process.platform === 'win32') {
            return await this.getDiskSpaceWindows(dirPath);
        }
        return await this.getDiskSpaceUnix(dirPath);
    }
    async getDiskSpaceWindows(dirPath) {
        const drive = this.getDrivePath(dirPath);
        return new Promise((resolve, reject) => {
            (0, child_process_1.exec)(`wmic logicaldisk where "DeviceID='${drive}'" get size,freespace /value`, (error, stdout) => {
                if (error) {
                    reject(error);
                    return;
                }
                const lines = stdout.trim().split('\n').filter(line => line.trim());
                let size = 0;
                let freeSpace = 0;
                for (const line of lines) {
                    const [key, value] = line.split('=').map(s => s.trim());
                    if (key === 'Size')
                        size = parseInt(value, 10) || 0;
                    if (key === 'FreeSpace')
                        freeSpace = parseInt(value, 10) || 0;
                }
                if (size === 0) {
                    reject(new Error(`无法获取 ${drive} 盘的磁盘空间信息`));
                    return;
                }
                resolve({ totalBytes: size, freeBytes: freeSpace });
            });
        });
    }
    async getDiskSpaceUnix(dirPath) {
        return new Promise((resolve, reject) => {
            (0, child_process_1.exec)(`df -B1 "${dirPath}"`, (error, stdout) => {
                if (error) {
                    reject(error);
                    return;
                }
                const lines = stdout.trim().split('\n');
                if (lines.length < 2) {
                    reject(new Error('无法解析 df 输出'));
                    return;
                }
                const parts = lines[1].split(/\s+/);
                const totalBytes = parseInt(parts[1], 10) || 0;
                const availableBytes = parseInt(parts[3], 10) || 0;
                resolve({ totalBytes, freeBytes: availableBytes });
            });
        });
    }
    async checkWritePermission(sourceDir, targetDir) {
        const now = Date.now();
        const testFileName = `.health-check-${Date.now()}.tmp`;
        const issues = [];
        const sourceTestPath = path_1.default.join(sourceDir, testFileName);
        const targetTestPath = path_1.default.join(targetDir, testFileName);
        try {
            await fs_extra_1.default.writeFile(sourceTestPath, 'health-check-test');
            await fs_extra_1.default.remove(sourceTestPath);
        }
        catch (error) {
            issues.push(`源目录无写入权限: ${error.message}`);
        }
        try {
            await fs_extra_1.default.writeFile(targetTestPath, 'health-check-test');
            await fs_extra_1.default.remove(targetTestPath);
        }
        catch (error) {
            issues.push(`目标目录无写入权限: ${error.message}`);
        }
        if (issues.length > 0) {
            return {
                type: 'writePermission',
                status: 'critical',
                message: issues.join('; '),
                details: { sourceDir, targetDir, issues },
                checkedAt: now
            };
        }
        return {
            type: 'writePermission',
            status: 'healthy',
            message: '源目录和目标目录均有读写权限',
            details: { sourceDir, targetDir },
            checkedAt: now
        };
    }
    async checkFileWatcher() {
        const now = Date.now();
        try {
            const status = FileWatcher_1.fileWatcher.getStatus();
            if (!status.isWatching) {
                return {
                    type: 'fileWatcher',
                    status: 'warning',
                    message: '文件监听器未运行',
                    details: status,
                    checkedAt: now
                };
            }
            const sourceWatching = status.sourceDir ? true : false;
            const targetWatching = status.targetDir ? true : false;
            if (!sourceWatching || !targetWatching) {
                return {
                    type: 'fileWatcher',
                    status: 'warning',
                    message: `监听器异常: ${!sourceWatching ? '源目录未监听' : ''}${!sourceWatching && !targetWatching ? ', ' : ''}${!targetWatching ? '目标目录未监听' : ''}`,
                    details: status,
                    checkedAt: now
                };
            }
            return {
                type: 'fileWatcher',
                status: 'healthy',
                message: '文件监听器运行正常',
                details: {
                    isWatching: status.isWatching,
                    silentPathCount: status.silentPathCount
                },
                checkedAt: now
            };
        }
        catch (error) {
            return {
                type: 'fileWatcher',
                status: 'warning',
                message: `文件监听器检查失败: ${error.message}`,
                details: { error: error.message },
                checkedAt: now
            };
        }
    }
    async checkMemoryUsage() {
        const now = Date.now();
        try {
            const memUsage = process.memoryUsage();
            const heapUsedMB = memUsage.heapUsed / (1024 * 1024);
            const rssMB = memUsage.rss / (1024 * 1024);
            let status = 'healthy';
            let message = `内存使用正常 (RSS: ${rssMB.toFixed(1)} MB)`;
            if (rssMB > MEMORY_WARNING_THRESHOLD_MB) {
                status = 'warning';
                message = `内存占用过高，可能存在内存泄漏 (RSS: ${rssMB.toFixed(1)} MB, 阈值: ${MEMORY_WARNING_THRESHOLD_MB} MB)`;
            }
            return {
                type: 'memoryUsage',
                status,
                message,
                details: {
                    rssMB: +rssMB.toFixed(2),
                    heapTotalMB: +(memUsage.heapTotal / (1024 * 1024)).toFixed(2),
                    heapUsedMB: +heapUsedMB.toFixed(2),
                    externalMB: +(memUsage.external / (1024 * 1024)).toFixed(2),
                    thresholdMB: MEMORY_WARNING_THRESHOLD_MB
                },
                checkedAt: now
            };
        }
        catch (error) {
            return {
                type: 'memoryUsage',
                status: 'warning',
                message: `内存使用检查失败: ${error.message}`,
                details: { error: error.message },
                checkedAt: now
            };
        }
    }
    async checkConflictCount() {
        const now = Date.now();
        try {
            const unresolvedConflicts = await ConflictDetector_1.ConflictDetector.getUnresolvedConflicts();
            const count = unresolvedConflicts.length;
            let status = 'healthy';
            let message = `未解决冲突 ${count} 个，在正常范围内`;
            if (count >= CONFLICT_WARNING_THRESHOLD) {
                status = 'warning';
                message = `未解决冲突数量激增 (${count} 个)，可能存在配置问题（阈值: ${CONFLICT_WARNING_THRESHOLD}）`;
            }
            else if (count > CONFLICT_WARNING_THRESHOLD / 2) {
                status = 'warning';
                message = `未解决冲突数量较多 (${count} 个)`;
            }
            return {
                type: 'conflictCount',
                status,
                message,
                details: {
                    conflictCount: count,
                    threshold: CONFLICT_WARNING_THRESHOLD
                },
                checkedAt: now
            };
        }
        catch (error) {
            return {
                type: 'conflictCount',
                status: 'warning',
                message: `冲突数量检查失败: ${error.message}`,
                details: { error: error.message },
                checkedAt: now
            };
        }
    }
    calculateOverallStatus(checks) {
        let hasWarning = false;
        for (const check of checks) {
            if (check.status === 'critical') {
                return 'critical';
            }
            if (check.status === 'warning') {
                hasWarning = true;
            }
        }
        return hasWarning ? 'warning' : 'healthy';
    }
    getBlockingReasonsFromChecks(checks) {
        const reasons = [];
        for (const check of checks) {
            if (BLOCKING_CHECKS.includes(check.type) && check.status === 'critical') {
                reasons.push(check.message);
            }
        }
        return reasons;
    }
    createEmptyReport() {
        return {
            overallStatus: 'warning',
            checks: [],
            lastCheckedAt: 0,
            syncBlocked: false,
            blockingReasons: []
        };
    }
    createErrorReport(errorMessage) {
        return {
            overallStatus: 'warning',
            checks: [
                {
                    type: 'sourceDirAccess',
                    status: 'warning',
                    message: `健康检查系统错误: ${errorMessage}`,
                    checkedAt: Date.now()
                }
            ],
            lastCheckedAt: Date.now(),
            syncBlocked: false,
            blockingReasons: []
        };
    }
    logReport(report) {
        const statusLabel = {
            healthy: '✓ 健康',
            warning: '⚠ 警告',
            critical: '✗ 严重'
        };
        console.log(`\n[HealthChecker] 健康检查报告 [${statusLabel[report.overallStatus]}]`);
        console.log('─'.repeat(50));
        for (const check of report.checks) {
            const icon = check.status === 'healthy' ? '  ✓' : check.status === 'warning' ? '  ⚠' : '  ✗';
            console.log(`${icon} ${check.type}: ${check.message}`);
        }
        if (report.syncBlocked) {
            console.log('\n  ⛔ 同步已被阻止，原因：');
            for (const reason of report.blockingReasons) {
                console.log(`     - ${reason}`);
            }
        }
        console.log(`\n  检查时间: ${new Date(report.lastCheckedAt).toLocaleString('zh-CN')}`);
        console.log('─'.repeat(50) + '\n');
    }
}
exports.HealthChecker = HealthChecker;
exports.healthChecker = new HealthChecker();
//# sourceMappingURL=HealthChecker.js.map