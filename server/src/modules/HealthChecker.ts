import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { EventEmitter } from 'events';
import { exec } from 'child_process';
import { HealthStatus, HealthCheckResult, HealthReport, CheckType } from '../types';
import { getConfig } from '../utils/storage';
import { fileWatcher } from './FileWatcher';
import { ConflictDetector } from './ConflictDetector';

const CHECK_INTERVAL_MS = 5 * 60 * 1000;
const CACHE_TTL_MS = 30 * 1000;
const DISK_SPACE_WARNING_THRESHOLD = 0.1;
const MEMORY_WARNING_THRESHOLD_MB = 500;
const CONFLICT_WARNING_THRESHOLD = 100;
const BLOCKING_CHECKS: CheckType[] = ['sourceDirAccess', 'targetDirAccess', 'diskSpace', 'writePermission'];

interface CachedResult {
  result: HealthReport;
  cachedAt: number;
}

export class HealthChecker extends EventEmitter {
  private timer: NodeJS.Timeout | null = null;
  private cache: CachedResult | null = null;
  private isRunning = false;
  private isChecking = false;

  async start(): Promise<void> {
    if (this.isRunning) return;

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

  async stop(): Promise<void> {
    if (!this.isRunning) return;

    this.isRunning = false;

    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    this.cache = null;
    console.log('[HealthChecker] Stopped');
  }

  async getHealthReport(forceRefresh: boolean = false): Promise<HealthReport> {
    if (!forceRefresh && this.cache && Date.now() - this.cache.cachedAt < CACHE_TTL_MS) {
      return this.cache.result;
    }

    if (this.isChecking) {
      if (this.cache) {
        return this.cache.result;
      }
      await this.waitForCheck();
      return this.cache!.result;
    }

    return await this.performCheck();
  }

  isSyncBlocked(): boolean {
    if (!this.cache) return false;
    return this.cache.result.syncBlocked;
  }

  getBlockingReasons(): string[] {
    if (!this.cache) return [];
    return this.cache.result.blockingReasons;
  }

  async triggerCheck(): Promise<HealthReport> {
    console.log('[HealthChecker] Manual check triggered');
    return await this.performCheck();
  }

  private async waitForCheck(): Promise<void> {
    return new Promise(resolve => {
      const checkInterval = setInterval(() => {
        if (!this.isChecking) {
          clearInterval(checkInterval);
          resolve();
        }
      }, 100);
    });
  }

  private async performCheck(): Promise<HealthReport> {
    if (this.isChecking) {
      return this.cache ? this.cache.result : this.createEmptyReport();
    }

    this.isChecking = true;

    try {
      const config = await getConfig();
      const checks: HealthCheckResult[] = [];

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

      const report: HealthReport = {
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
    } catch (error: any) {
      console.error('[HealthChecker] Check failed:', error);
      const report = this.createErrorReport(error.message);
      this.cache = { result: report, cachedAt: Date.now() };
      return report;
    } finally {
      this.isChecking = false;
    }
  }

  private async checkSourceDirAccess(sourceDir: string): Promise<HealthCheckResult> {
    const now = Date.now();
    try {
      const exists = await fs.pathExists(sourceDir);
      if (!exists) {
        return {
          type: 'sourceDirAccess',
          status: 'critical',
          message: `源目录不存在: ${sourceDir}`,
          details: { path: sourceDir },
          checkedAt: now
        };
      }

      const stat = await fs.stat(sourceDir);
      if (!stat.isDirectory()) {
        return {
          type: 'sourceDirAccess',
          status: 'critical',
          message: `源路径不是目录: ${sourceDir}`,
          details: { path: sourceDir },
          checkedAt: now
        };
      }

      await fs.access(sourceDir, fs.constants.R_OK);

      return {
        type: 'sourceDirAccess',
        status: 'healthy',
        message: '源目录可正常访问',
        details: { path: sourceDir },
        checkedAt: now
      };
    } catch (error: any) {
      return {
        type: 'sourceDirAccess',
        status: 'critical',
        message: `源目录访问失败: ${error.message}`,
        details: { path: sourceDir, error: error.message },
        checkedAt: now
      };
    }
  }

  private async checkTargetDirAccess(targetDir: string): Promise<HealthCheckResult> {
    const now = Date.now();
    try {
      const exists = await fs.pathExists(targetDir);
      if (!exists) {
        return {
          type: 'targetDirAccess',
          status: 'critical',
          message: `目标目录不存在: ${targetDir}`,
          details: { path: targetDir },
          checkedAt: now
        };
      }

      const stat = await fs.stat(targetDir);
      if (!stat.isDirectory()) {
        return {
          type: 'targetDirAccess',
          status: 'critical',
          message: `目标路径不是目录: ${targetDir}`,
          details: { path: targetDir },
          checkedAt: now
        };
      }

      await fs.access(targetDir, fs.constants.R_OK);

      return {
        type: 'targetDirAccess',
        status: 'healthy',
        message: '目标目录可正常访问',
        details: { path: targetDir },
        checkedAt: now
      };
    } catch (error: any) {
      return {
        type: 'targetDirAccess',
        status: 'critical',
        message: `目标目录访问失败: ${error.message}`,
        details: { path: targetDir, error: error.message },
        checkedAt: now
      };
    }
  }

  private async checkDiskSpace(sourceDir: string, targetDir: string): Promise<HealthCheckResult> {
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

      let status: HealthStatus = 'healthy';
      let message = '磁盘空间充足';

      if (minFreePercent < DISK_SPACE_WARNING_THRESHOLD) {
        status = 'critical';
        message = `${minDrive}磁盘空间不足，剩余 ${(minFreePercent * 100).toFixed(1)}%（低于 10% 阈值）`;
      } else if (minFreePercent < DISK_SPACE_WARNING_THRESHOLD * 2) {
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
    } catch (error: any) {
      return {
        type: 'diskSpace',
        status: 'warning',
        message: `磁盘空间检查失败: ${error.message}`,
        details: { error: error.message },
        checkedAt: now
      };
    }
  }

  private getDrivePath(dirPath: string): string {
    if (process.platform === 'win32') {
      const match = dirPath.match(/^([a-zA-Z]:)/);
      return match ? match[1] : 'C:';
    }
    return '/';
  }

  private async getDiskSpace(dirPath: string): Promise<{ totalBytes: number; freeBytes: number }> {
    if (process.platform === 'win32') {
      return await this.getDiskSpaceWindows(dirPath);
    }
    return await this.getDiskSpaceUnix(dirPath);
  }

  private async getDiskSpaceWindows(dirPath: string): Promise<{ totalBytes: number; freeBytes: number }> {
    const drive = this.getDrivePath(dirPath);
    return new Promise((resolve, reject) => {
      exec(`wmic logicaldisk where "DeviceID='${drive}'" get size,freespace /value`, (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }

        const lines = stdout.trim().split('\n').filter(line => line.trim());
        let size = 0;
        let freeSpace = 0;

        for (const line of lines) {
          const [key, value] = line.split('=').map(s => s.trim());
          if (key === 'Size') size = parseInt(value, 10) || 0;
          if (key === 'FreeSpace') freeSpace = parseInt(value, 10) || 0;
        }

        if (size === 0) {
          reject(new Error(`无法获取 ${drive} 盘的磁盘空间信息`));
          return;
        }

        resolve({ totalBytes: size, freeBytes: freeSpace });
      });
    });
  }

  private async getDiskSpaceUnix(dirPath: string): Promise<{ totalBytes: number; freeBytes: number }> {
    return new Promise((resolve, reject) => {
      exec(`df -B1 "${dirPath}"`, (error, stdout) => {
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

  private async checkWritePermission(sourceDir: string, targetDir: string): Promise<HealthCheckResult> {
    const now = Date.now();
    const testFileName = `.health-check-${Date.now()}.tmp`;
    const issues: string[] = [];

    const sourceTestPath = path.join(sourceDir, testFileName);
    const targetTestPath = path.join(targetDir, testFileName);

    try {
      await fs.writeFile(sourceTestPath, 'health-check-test');
      await fs.remove(sourceTestPath);
    } catch (error: any) {
      issues.push(`源目录无写入权限: ${error.message}`);
    }

    try {
      await fs.writeFile(targetTestPath, 'health-check-test');
      await fs.remove(targetTestPath);
    } catch (error: any) {
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

  private async checkFileWatcher(): Promise<HealthCheckResult> {
    const now = Date.now();
    try {
      const status = fileWatcher.getStatus();

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
    } catch (error: any) {
      return {
        type: 'fileWatcher',
        status: 'warning',
        message: `文件监听器检查失败: ${error.message}`,
        details: { error: error.message },
        checkedAt: now
      };
    }
  }

  private async checkMemoryUsage(): Promise<HealthCheckResult> {
    const now = Date.now();
    try {
      const memUsage = process.memoryUsage();
      const heapUsedMB = memUsage.heapUsed / (1024 * 1024);
      const rssMB = memUsage.rss / (1024 * 1024);

      let status: HealthStatus = 'healthy';
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
    } catch (error: any) {
      return {
        type: 'memoryUsage',
        status: 'warning',
        message: `内存使用检查失败: ${error.message}`,
        details: { error: error.message },
        checkedAt: now
      };
    }
  }

  private async checkConflictCount(): Promise<HealthCheckResult> {
    const now = Date.now();
    try {
      const unresolvedConflicts = await ConflictDetector.getUnresolvedConflicts();
      const count = unresolvedConflicts.length;

      let status: HealthStatus = 'healthy';
      let message = `未解决冲突 ${count} 个，在正常范围内`;

      if (count >= CONFLICT_WARNING_THRESHOLD) {
        status = 'warning';
        message = `未解决冲突数量激增 (${count} 个)，可能存在配置问题（阈值: ${CONFLICT_WARNING_THRESHOLD}）`;
      } else if (count > CONFLICT_WARNING_THRESHOLD / 2) {
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
    } catch (error: any) {
      return {
        type: 'conflictCount',
        status: 'warning',
        message: `冲突数量检查失败: ${error.message}`,
        details: { error: error.message },
        checkedAt: now
      };
    }
  }

  private calculateOverallStatus(checks: HealthCheckResult[]): HealthStatus {
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

  private getBlockingReasonsFromChecks(checks: HealthCheckResult[]): string[] {
    const reasons: string[] = [];

    for (const check of checks) {
      if (BLOCKING_CHECKS.includes(check.type) && check.status === 'critical') {
        reasons.push(check.message);
      }
    }

    return reasons;
  }

  private createEmptyReport(): HealthReport {
    return {
      overallStatus: 'warning',
      checks: [],
      lastCheckedAt: 0,
      syncBlocked: false,
      blockingReasons: []
    };
  }

  private createErrorReport(errorMessage: string): HealthReport {
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

  private logReport(report: HealthReport): void {
    const statusLabel: Record<HealthStatus, string> = {
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

export const healthChecker = new HealthChecker();
