path = '/Users/macbook/apex-os/src/app/api/cron/route.ts'
with open(path, 'r') as f:
    lines = f.readlines()

for i, line in enumerate(lines):
    if 'Processed ${results.length} payouts, total' in line:
        insert_idx = i + 2
        indent = '    '
        new_lines = [
            '\n',
            indent + '// Sprint 4: Queue payout-sent emails for each affected affiliate (non-blocking)\n',
            indent + 'for (const result of results) {\n',
            indent + '  void (async () => {\n',
            indent + '    try {\n',
            indent + '      const affiliate = affiliateMap.get(result.affiliate_id) as { email?: string; full_name?: string } | undefined;\n',
            indent + '      if (!affiliate?.email) return;\n',
            indent + '      const { payoutCompletedTemplate } = await import(\'@/lib/emails/templates\');\n',
            indent + '      const { getEmailQueueService } = await import(\'@/lib/emails/email-queue\');\n',
            indent + '      const html = payoutCompletedTemplate({\n',
            indent + '        userName: affiliate.full_name || \'Affiliate\',\n',
            indent + '        userEmail: affiliate.email,\n',
            indent + "        locale: 'en',\n",
            indent + "        baseUrl: process.env.NEXT_PUBLIC_BASE_URL || 'https://apex-os.com',\n",
            indent + '        amount: result.amount as number,\n',
            indent += '        transactionHash: result.payout_id,\n',
        ]
        break

