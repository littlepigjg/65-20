import { useState, useEffect } from 'react';
import { syncApi, recordsApi, healthApi } from '../api';
import { SyncStatus, SyncRecord, HealthReport, HealthCheckResult, CheckType } from '../types';

interface DashboardProps {
  status: SyncStatus | null;
}

function formatTime(timestamp: number): string {
  if (!timestamp) return '从未同步';
  const date = new Date(timestamp);
  return date.toLocaleString('zh-CN');
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

function getActionLabel(action: string): string {
  const map: Record<string, string> = {
    copy: '复制',
    delete: '删除',
    update: '更新',
    conflict: '冲突'
  };
  return map[action] || action;
}

function getStatusBadgeClass(status: string): string {
  const map: Record<string, string> = {
    success: 'badge-success',
    failed: 'badge-danger',
    pending: 'badge-warning'
  };
  return map[status] || 'badge-info';
}

function getStatusBadge(status: string): string {
  const map: Record<string, string> = {
    success: '成功',
    failed: '失败',
    pending: '等待中'
  };
  return map[status] || status;
}

function getHealthStatusLabel(status: string): string {
  const map: Record<string, string> = {
    healthy: '健康',
    warning: '警告',
    critical: '严重'
  };
  return map[status] || status;
}

function getHealthStatusClass(status: string): string {
  const map: Record<string, string> = {
    healthy: 'health-healthy',
    warning: 'health-warning',
    critical: 'health-critical'
  };
  return map[status] || '';
}

function getCheckTypeLabel(type: CheckType): string {
  const map: Record<CheckType, string> = {
    sourceDirAccess: '源目录访问',
    targetDirAccess: '目标目录访问',
    diskSpace: '磁盘空间',
    writePermission: '写入权限',
    fileWatcher: '文件监听器',
    memoryUsage: '内存使用',
    conflictCount: '冲突数量'
  };
  return map[type] || type;
}

function getCheckIcon(status: string): string {
  const map: Record<string, string> = {
    healthy: '✓',
    warning: '⚠',
    critical: '✗'
  };
  return map[status] || '?';
}

function HealthTrafficLight({ health }: { health: HealthReport | undefined }) {
  if (!health) return null;

  return (
    <div className="health-traffic-light">
      <div className={`traffic-light ${health.overallStatus}`}>
        <div className="light healthy-light">
          <span className="light-indicator" />
          <span className="light-label">健康</span>
        </div>
        <div className="light warning-light">
          <span className="light-indicator" />
          <span className="light-label">警告</span>
        </div>
        <div className="light critical-light">
          <span className="light-indicator" />
          <span className="light-label">严重</span>
        </div>
      </div>
      <div className="health-status-text">
        <span className={`status-label ${health.overallStatus}`}>
          {getHealthStatusLabel(health.overallStatus)}
        </span>
        {health.syncBlocked && (
          <span className="sync-blocked-badge">⛔ 同步已阻止</span>
        )}
      </div>
    </div>
  );
}

function HealthCheckItem({ check }: { check: HealthCheckResult }) {
  const [expanded, setExpanded] = useState(false);
  const hasDetails = check.details && Object.keys(check.details).length > 0;

  return (
    <div className={`health-check-item ${check.status}`}>
      <div className="health-check-header" onClick={() => hasDetails && setExpanded(!expanded)}>
        <span className={`check-icon ${check.status}`}>
          {getCheckIcon(check.status)}
        </span>
        <span className="check-type">{getCheckTypeLabel(check.type)}</span>
        <span className="check-message">{check.message}</span>
        {hasDetails && (
          <span className="expand-icon">{expanded ? '▲' : '▼'}</span>
        )}
      </div>
      {expanded && hasDetails && (
        <div className="health-check-details">
          <pre>{JSON.stringify(check.details, null, 2)}</pre>
        </div>
      )}
    </div>
  );
}

export default function Dashboard({ status }: DashboardProps) {
  const [localStatus, setLocalStatus] = useState<SyncStatus | null>(status);
  const [records, setRecords] = useState<SyncRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [showHealthDetails, setShowHealthDetails] = useState(false);

  useEffect(() => {
    if (status) {
      setLocalStatus(status);
    }
  }, [status]);

  useEffect(() => {
    loadData();
  }, []);

  async function loadData() {
    try {
      const [statusData, recordsData] = await Promise.all([
        syncApi.getStatus(),
        recordsApi.getRecent(20)
      ]);
      setLocalStatus(statusData);
      setRecords(recordsData);
    } finally {
      setLoading(false);
    }
  }

  async function handleStart() {
    const newStatus = await syncApi.start();
    setLocalStatus(newStatus);
  }

  async function handleStop() {
    const newStatus = await syncApi.stop();
    setLocalStatus(newStatus);
  }

  async function handleSyncNow() {
    const newStatus = await syncApi.syncNow();
    setLocalStatus(newStatus);
    loadData();
  }

  async function handleRefreshHealth() {
    try {
      const healthReport = await healthApi.triggerCheck();
      if (localStatus) {
        setLocalStatus({
          ...localStatus,
          health: healthReport
        });
      }
    } catch (error) {
      console.error('Failed to refresh health:', error);
    }
  }

  if (loading || !localStatus) {
    return (
      <div className="loading">
        <div className="spinner"></div>
      </div>
    );
  }

  const health = localStatus.health;

  return (
    <div>
      <div className="card health-card">
        <div className="card-header">
          <h2>系统健康状态</h2>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button
              className="btn btn-secondary"
              onClick={() => setShowHealthDetails(!showHealthDetails)}
            >
              {showHealthDetails ? '收起详情' : '查看详情'}
            </button>
            <button className="btn btn-primary" onClick={handleRefreshHealth}>
              🔄 立即检查
            </button>
          </div>
        </div>

        <div className="health-overview">
          <HealthTrafficLight health={health} />

          <div className="health-summary">
            <div className="summary-item">
              <span className="summary-label">检查时间</span>
              <span className="summary-value">{formatTime(health?.lastCheckedAt)}</span>
            </div>
            <div className="summary-item">
              <span className="summary-label">检查项</span>
              <span className="summary-value">{health?.checks.length || 0} 项</span>
            </div>
            <div className="summary-item">
              <span className="summary-label">通过</span>
              <span className="summary-value healthy-count">
                {health?.checks.filter(c => c.status === 'healthy').length || 0} 项
              </span>
            </div>
            <div className="summary-item">
              <span className="summary-label">警告</span>
              <span className="summary-value warning-count">
                {health?.checks.filter(c => c.status === 'warning').length || 0} 项
              </span>
            </div>
            <div className="summary-item">
              <span className="summary-label">严重</span>
              <span className="summary-value critical-count">
                {health?.checks.filter(c => c.status === 'critical').length || 0} 项
              </span>
            </div>
          </div>
        </div>

        {health?.syncBlocked && (
          <div className="sync-blocked-warning">
            <div className="warning-icon">⛔</div>
            <div className="warning-content">
              <strong>同步已被阻止</strong>
              <p>为避免数据损坏，同步操作已暂停。请解决以下问题后恢复：</p>
              <ul>
                {health.blockingReasons.map((reason, index) => (
                  <li key={index}>{reason}</li>
                ))}
              </ul>
            </div>
          </div>
        )}

        {showHealthDetails && (
          <div className="health-checks-list">
            {health?.checks.map((check, index) => (
              <HealthCheckItem key={index} check={check} />
            ))}
          </div>
        )}
      </div>

      <div className="card">
        <div className="card-header">
          <h2>同步状态</h2>
          <div style={{ display: 'flex', gap: '8px' }}>
            {localStatus.isRunning ? (
              <button className="btn btn-danger" onClick={handleStop} disabled={health?.syncBlocked}>
                ⏹ 停止同步
              </button>
            ) : (
              <button className="btn btn-success" onClick={handleStart}>
                ▶ 开始同步
              </button>
            )}
            <button
              className="btn btn-primary"
              onClick={handleSyncNow}
              disabled={health?.syncBlocked}
            >
              🔄 立即同步
            </button>
          </div>
        </div>

        {health?.syncBlocked && (
          <div className="alert alert-warning">
            ⚠️ 由于健康检查未通过，同步操作已被暂时禁用。请检查系统健康状态。
          </div>
        )}

        <div className="status-grid">
          <div className={`status-card ${localStatus.isRunning ? 'success' : ''}`}>
            <div className="label">服务状态</div>
            <div className="value">
              {localStatus.isRunning ? '运行中' : '已停止'}
            </div>
            <div className="subtext">
              {localStatus.isRunning ? '● 正在监视文件变化' : '○ 同步服务未运行'}
            </div>
          </div>

          <div className="status-card">
            <div className="label">总文件数</div>
            <div className="value">{localStatus.totalFiles}</div>
            <div className="subtext">已跟踪的文件数量</div>
          </div>

          <div className={`status-card ${localStatus.pendingSyncCount > 0 ? 'warning' : ''}`}>
            <div className="label">待同步</div>
            <div className="value">{localStatus.pendingSyncCount}</div>
            <div className="subtext">等待处理的变更数</div>
          </div>

          <div className={`status-card ${localStatus.conflictCount > 0 ? 'danger' : ''}`}>
            <div className="label">冲突文件</div>
            <div className="value">{localStatus.conflictCount}</div>
            <div className="subtext">需要手动解决的冲突</div>
          </div>
        </div>

        <div className="form-row">
          <div className="form-group">
            <label>源目录</label>
            <input type="text" value={localStatus.sourceDir} readOnly />
          </div>
          <div className="form-group">
            <label>目标目录</label>
            <input type="text" value={localStatus.targetDir} readOnly />
          </div>
        </div>

        <div className="form-group">
          <label>上次同步时间</label>
          <input
            type="text"
            value={formatTime(localStatus.lastSyncTime)}
            readOnly
          />
        </div>
      </div>

      <div className="card">
        <div className="card-header">
          <h2>最近同步记录</h2>
          <button className="btn btn-secondary" onClick={loadData}>
            🔄 刷新
          </button>
        </div>

        {records.length === 0 ? (
          <div className="empty-state">
            <div className="icon">📝</div>
            <h3>暂无同步记录</h3>
            <p>开始同步后，这里会显示同步历史</p>
          </div>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>时间</th>
                <th>操作</th>
                <th>文件</th>
                <th>来源</th>
                <th>状态</th>
                <th>说明</th>
              </tr>
            </thead>
            <tbody>
              {records.map((record) => (
                <tr key={record.id}>
                  <td style={{ fontSize: '12px', color: '#718096' }}>
                    {formatTime(record.timestamp)}
                  </td>
                  <td>
                    <span className={`badge ${record.action === 'conflict' ? 'badge-danger' : 'badge-info'}`}>
                      {getActionLabel(record.action)}
                    </span>
                  </td>
                  <td style={{ fontFamily: 'Consolas, monospace', fontSize: '12px' }}>
                    {record.filePath}
                  </td>
                  <td>
                    <span className="badge badge-info">
                      {record.source === 'source' ? '源目录' : '目标目录'}
                    </span>
                  </td>
                  <td>
                    <span className={`badge ${getStatusBadgeClass(record.status)}`}>
                      {getStatusBadge(record.status)}
                    </span>
                  </td>
                  <td style={{ fontSize: '12px', color: '#718096' }}>
                    {record.message || '-'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
