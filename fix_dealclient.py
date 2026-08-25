from pathlib import Path
import re

path = Path('/Users/macbook/apex-os/src/app/[locale]/admin/deals/DealListClient.tsx')
text = path.read_text()

# 1) Fix handleSubmit: target_cities/target_regions are orphaned after `}`
# Move them inside the payload object before the closing `}`
old = " ends_at: form.ends_at || undefined,\n }\n target_cities: form.target_cities && form.target_cities.length > 0 ? form.target_cities : undefined,\n target_regions: form.target_regions && form.target_regions.length > 0 ? form.target_regions : undefined,\n\n try {"
new = " ends_at: form.ends_at || undefined,\n target_cities: form.target_cities && form.target_cities.length > 0 ? form.target_cities : undefined,\n target_regions: form.target_regions && form.target_regions.length > 0 ? form.target_regions : undefined,\n }\n\n try {"
text = text.replace(old, new)
print("Fixed handleSubmit payload")

# 2) Fix openEditModal: add cities/regions fields
old2 = " ends_at: deal.ends_at || '',\n })\n setFormError"
new2 = " ends_at: deal.ends_at || '',\n cities_input: deal.target_cities ? deal.target_cities.join(', ') : '',\n regions_input: deal.target_regions ? deal.target_regions.join(', ') : '',\n target_cities: deal.target_cities || [],\n target_regions: deal.target_regions || [],\n })\n setFormError"
text = text.replace(old2, new2)
print("Fixed openEditModal")

path.write_text(text)
print("Done")
