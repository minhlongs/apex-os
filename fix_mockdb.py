with open('/Users/macbook/apex-os/__tests__/lib/notifications/business-alert-engine.test.ts', 'r') as f:
    lines = f.readlines()

# Find and replace the createMockDB function (lines 32-45)
start = None
end = None
for i, line in enumerate(lines):
    if 'const createMockDB = () => {' in line and start is None:
        start = i
    if start is not None and '};' in line and i > start:
        end = i
        break

if start is None or end is None:
    print(f'Could not find createMockDB: start={start}, end={end}')
    exit(1)

new_mock = '''// Mock D1 Database
// D1 prepared statements are callable AND carry .bind(), .all(), .first(), .run().
// Code chains .prepare().bind(...).all() so bind() must return the same statement
// object that tests configure mocks on.
const createMockDB = () => {
  const stmt = {
    bind: vi.fn(() => stmt),
    all: vi.fn(),
    first: vi.fn(),
    run: vi.fn(),
  };
  return {
    prepare: vi.fn(() => stmt),
    exec: vi.fn(),
    batch: vi.fn(),
    close: vi.fn(),
  };
};
'''

new_lines = lines[:start] + [new_mock + '\n'] + lines[end+1:]

with open('/Users/macbook/apex-os/__tests__/lib/notifications/business-alert-engine.test.ts', 'w') as f:
    f.writelines(new_lines)

print(f'Replaced lines {start+1}-{end+1} with new createMockDB')
