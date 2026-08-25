from pathlib import Path

path = Path('/Users/macbook/apex-os/src/app/[locale]/admin/deals/DealListClient.tsx')
lines = path.read_text().splitlines()

# Track line offsets as we insert/delete
offset = 0
total = len(lines)

def show_range(name, start, end):
    end = min(end, total - 1)
    print(f'--- {name} (lines {start+1}-{end+1}) ---')
    for i in range(start, end + 1):
        print(f"  {i+1}: {repr(lines[i])}")

# Show BEFORE patches
show_range('handleInputChange', 158 + offset, 167 + offset)
show_range('exchange line', 184 + offset, 185 + offset)
show_range('payload close', 188 + offset, 192 + offset)
show_range('openEditModal end', 150 + offset, 155 + offset)
show_range('exchangeNames', 268 + offset, 276 + offset)
show_range('broken JSX', 742 + offset, 776 + offset)

# --- Patch 1: handleInputChange block (lines 159-166) ---
start, end = 158 + offset, 166 + offset
replacement = [
    " const handleInputChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => {",
    "  const { name, value, type } = e.target",
    "  setForm(prev => {",
    "   const updated = {",
    "    ...prev,",
    "    [name]: type === 'checkbox' ? (e.target as HTMLInputElement).checked : value",
    "   }",
    "",
    "   if (name === 'cities_input') {",
    "    updated.target_cities = value.split(',').map((c) => c.trim().toLowerCase()).filter(Boolean)",
    "   }",
    "   if (name === 'regions_input') {",
    "    updated.target_regions = value.split(',').map((c) => c.trim().toLowerCase()).filter(Boolean)",
    "   }",
    "",
    "   return updated",
    "  })",
    " }",
]
lines[start:end + 1] = replacement
delta = len(replacement) - (end - start + 1)
offset += delta
print(f'Patch 1 done: delta={delta}, offset={offset}')
show_range('after patch 1', start, start + len(replacement) - 1)

# --- Patch 2: exchange union type add kucoin (line 185) ---
idx = 184 + offset
lines[idx] = lines[idx].replace(
    "'binance' | 'bybit' | 'okx' | 'ftx' | 'coinbase' | 'kraken'",
    "'binance' | 'bybit' | 'okx' | 'kucoin' | 'ftx' | 'coinbase' | 'kraken'"
)
print(f'Patch 2 done: line {idx+1} = {repr(lines[idx])}')

# --- Patch 3: Add target_cities/target_regions to payload close (after ends_at) ---
idx = 190 + offset  # line 191 (ends_at line)
# Insert 2 new lines after ends_at
lines[idx + 1:idx + 1] = [
    " target_cities: form.target_cities && form.target_cities.length > 0 ? form.target_cities : undefined,",
    " target_regions: form.target_regions && form.target_regions.length > 0 ? form.target_regions : undefined,",
]
offset += 2
print(f'Patch 3 done: offset={offset}')
show_range('after patch 3', 188 + offset - 2, 194 + offset - 2)

# --- Patch 4: openEditModal populate cities/regions (lines 151-153, before }) ---
idx = 152 + offset  # 0-indexed line 153 = ends_at: deal.ends_at...
# Find the line with "ends_at: deal.ends_at" from openEditModal
found = False
for i in range(150 + offset, 160 + offset):
    if "ends_at: deal.ends_at || ''" in lines[i]:
        lines[i + 1:i + 1] = [
            " cities_input: deal.target_cities ? deal.target_cities.join(', ') : '',",
            " regions_input: deal.target_regions ? deal.target_regions.join(', ') : '',",
            " target_cities: deal.target_cities || [],",
            " target_regions: deal.target_regions || [],",
        ]
        offset += 4
        found = True
        print(f'Patch 4 done: inserted after line {i+1}, offset={offset}')
        break
if not found:
    print('WARNING: Patch 4 skipped - ends_at line not found')

# --- Patch 5: Add kucoin to renderExchange map ---
idx = 270 + offset  # line 271 = okx: 'OKX',
lines[idx + 1:idx + 1] = [" kucoin: 'KuCoin',"]
offset += 1
print(f'Patch 5 done: offset={offset}')
show_range('after patch 5', 268 + offset - 1, 276 + offset - 1)

# --- Patch 6: Replace broken city/region JSX (lines 743-774, 0-indexed 742-773) ---
start, end = 742 + offset, 774 + offset
jsx_replacement = [
    '<div>',
    ' <label className="block text-sm font-medium text-gray-700 mb-1">Target Cities</label>',
    ' <input',
    '  type="text"',
    '  name="cities_input"',
    "  value={form.cities_input || ''}",
    '  onChange={handleInputChange}',
    '  placeholder="hanoi, ho-chi-minh-city"',
    '  className="w-full rounded-lg border-gray-300 border px-3 py-2 text-sm focus:border-indigo-500 focus:ring-indigo-500"',
    ' />',
    ' <p className="text-xs text-gray-500 mt-1">Comma-separated city slugs</p>',
    '</div>',
    '<div>',
    ' <label className="block text-sm font-medium text-gray-700 mb-1">Target Regions</label>',
    ' <input',
    '  type="text"',
    '  name="regions_input"',
    "  value={form.regions_input || ''}",
    '  onChange={handleInputChange}',
    '  placeholder="vietnam, southeast-asia"',
    '  className="w-full rounded-lg border-gray-300 border px-3 py-2 text-sm focus:border-indigo-500 focus:ring-indigo-500"',
    ' />',
    ' <p className="text-xs text-gray-500 mt-1">Comma-separated region slugs</p>',
    '</div>',
]
lines[start:end + 1] = jsx_replacement
delta6 = len(jsx_replacement) - (end - start + 1)
offset += delta6
print(f'Patch 6 done: {end - start + 1} -> {len(jsx_replacement)}, delta={delta6}, offset={offset}')

# Write back
path.write_text('\\n'.join(lines) + '\\n')
print(f'\\nDealListClient.tsx written successfully. Total lines: {len(lines)}')
