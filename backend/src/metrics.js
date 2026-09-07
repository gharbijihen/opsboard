function makeKey(labels) {
  return Object.entries(labels)
    .map(([key, value]) => `${key}="${String(value).replaceAll('"', '\\"')}"`)
    .join(',');
}

export function createMetrics() {
  const startedAt = Date.now();
  const requestCounts = new Map();
  let errorCount = 0;
  let durationCount = 0;
  let durationSumMs = 0;

  return {
    record({ durationMs, method, route, status }) {
      const key = makeKey({ method, route, status });
      requestCounts.set(key, (requestCounts.get(key) ?? 0) + 1);
      durationCount += 1;
      durationSumMs += durationMs;
      if (status >= 500) {
        errorCount += 1;
      }
    },

    render() {
      const lines = [
        '# HELP opsboard_uptime_seconds Application uptime in seconds.',
        '# TYPE opsboard_uptime_seconds gauge',
        `opsboard_uptime_seconds ${Math.floor((Date.now() - startedAt) / 1000)}`,
        '# HELP opsboard_http_requests_total HTTP requests by method, route, and status.',
        '# TYPE opsboard_http_requests_total counter'
      ];

      for (const [labels, value] of requestCounts.entries()) {
        lines.push(`opsboard_http_requests_total{${labels}} ${value}`);
      }

      lines.push(
        '# HELP opsboard_http_errors_total HTTP 5xx responses.',
        '# TYPE opsboard_http_errors_total counter',
        `opsboard_http_errors_total ${errorCount}`,
        '# HELP opsboard_http_request_duration_ms_avg Average request duration in milliseconds.',
        '# TYPE opsboard_http_request_duration_ms_avg gauge',
        `opsboard_http_request_duration_ms_avg ${durationCount === 0 ? 0 : (durationSumMs / durationCount).toFixed(2)}`
      );

      return `${lines.join('\n')}\n`;
    }
  };
}
