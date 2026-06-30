with open('/Users/macbook/apex-os/src/lib/notifications/business-alert-engine.ts', 'r') as f:
    content = f.read()

old = """  // Normalize to oldest-first ordering regardless of input order
  const values = [...data].reverse().map(item => Number(item[metricKey]) || 0);
  const mid = Math.floor(values.length / 2);
  const older = values.slice(0, mid);
  const recent = values.slice(mid);

  if (older.length === 0 || recent.length === 0) return "stable";

  const olderAvg = older.reduce((a, b) => a + b, 0) / older.length;
  const recentAvg = recent.reduce((a, b) => a + b, 0) / recent.length;"""

new = """  // Data may arrive newest-first (from DB ORDER BY DESC) or oldest-first.
  // Reverse so index 0 = oldest, then compare first half vs second half.
  const values = [...data].reverse().map(item => Number(item[metricKey]) || 0);
  const mid = Math.floor(values.length / 2);
  const older = values.slice(0, mid);
  const recent = values.slice(mid);

  if (older.length === 0 || recent.length === 0) return "stable";

  const olderAvg = older.reduce((a, b) => a + b, 0) / older.length;
  const recentAvg = recent.reduce((a, b) => a + b, 0) / recent.length;"""

if old in content:
    content = content.replace(old, new)
    with open('/Users/macbook/apex-os/src/lib/notifications/business-alert-engine.ts', 'w') as f:
        f.write(content)
    print('calculateTrend comment updated')
else:
    print('Pattern not found')
