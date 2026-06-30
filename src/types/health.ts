/**
 * Health check response type
 */
export interface HealthStatus {
  status: 'ok' | 'degraded' | 'error';
  timestamp: string;
  environment: 'development' | 'production' | 'test';
  uptime: number;
  version: string;
  responseTime: number;
  checks?: {
    database: 'connected' | 'error' | 'not_configured';
    kv: 'connected' | 'error' | 'not_configured';
  };
  memory?: {
    rss: string;
    heapTotal: string;
    heapUsed: string;
  };
}
