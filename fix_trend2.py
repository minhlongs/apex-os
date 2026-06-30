with open('/Users/macbook/apex-os/src/lib/notifications/business-alert-engine.ts', 'r') as f:
    content = f.read()

old = """  // Normalize to oldest-first ordering regardless of input order
  const values = [...data].reverse().map(item => Number(item[metricKey]) || 0);
  const mid = Math.floor(values.length / 2);
  const older = values.slice(0, mid);
  const recent = values.slice(mid);"""

new = """  // Normalize to oldest-first ordering regardless of input order
  const values = [...data].reverse().map(item => Number(item[metricKey]) || 0);
  const mid = Math.floor(values.length / 2);
  const recent = values.slice(0, mid);
  const older = values.slice(mid);"""

if old in content:
    content = content.replace(old, new)
    with open('/Users/macbook/apex-os/src/lib/notifications/business-alert-engine.ts', 'w') as f:
        f.write(content)
    print('Fixed calculateTrend variable names')
else:
    print('Pattern not found')
