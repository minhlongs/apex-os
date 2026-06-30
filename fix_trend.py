with open('/Users/macbook/apex-os/src/lib/notifications/business-alert-engine.ts', 'r') as f:
    lines = f.readlines()

# Replace lines 651-688 (0-indexed: 650-687) with the corrected function
new_lines = lines[:650]
new_lines.append('export function calculateTrend<T extends Record<string, unknown>>(\n')
new_lines.append('  data: T[],\n')
new_lines.append('  metricKey: keyof T\n')
new_lines.append("): 'up' | 'down' | 'stable' {\n")
new_lines.append('  if (data.length < 2) return "stable";\n')
new_lines.append('\n')
new_lines.append('  // Normalize to oldest-first ordering regardless of input order\n')
new_lines.append('  const values = [...data].reverse().map(item => Number(item[metricKey]) || 0);\n')
new_lines.append('  const mid = Math.floor(values.length / 2);\n')
new_lines.append('  const older = values.slice(0, mid);\n')
new_lines.append('  const recent = values.slice(mid);\n')
new_lines.append('\n')
new_lines.append('  if (older.length === 0 || recent.length === 0) return "stable";\n')
new_lines.append('\n')
new_lines.append('  const olderAvg = older.reduce((a, b) => a + b, 0) / older.length;\n')
new_lines.append('  const recentAvg = recent.reduce((a, b) => a + b, 0) / recent.length;\n')
new_lines.append('  const changePct = ((recentAvg - olderAvg) / olderAvg) * 100;\n')
new_lines.append('\n')
new_lines.append('  if (changePct > 5) return "up";\n')
new_lines.append('  if (changePct < -5) return "down";\n')
new_lines.append('  return "stable";\n')
new_lines.append('}\n')
new_lines.append('\n')
new_lines.extend(lines[688:])

with open('/Users/macbook/apex-os/src/lib/notifications/business-alert-engine.ts', 'w') as f:
    f.writelines(new_lines)
print('Fixed. Total lines:', len(new_lines))
