import { commissionEarnedTemplate, plainTextTemplate } from '@/lib/emails/templates';

describe('template executor contract', () => {
  const sample = {
    locale: 'en' as const,
    baseUrl: 'https://example.apex-os.com',
    userName: 'Ren',
    userEmail: 'ren@example.com',
    amount: 12.5,
    dealName: 'Stellar trade',
    exchange: 'Binance',
    tradeVolume: 150,
    tier: 1,
    payoutStatus: 'pending',
    payoutDate: '',
  };

  it('commissionEarnedTemplate returns real, non-empty HTML with branded subject', () => {
    const html = commissionEarnedTemplate(sample);

    expect(typeof html).toBe('string');
    expect(html).toBeTruthy();
    expect(html).toContain('ApexOS');
    expect(html).toContain('12.5');
    expect(html).toMatch(/<style[^>]*>[^<]+<\/style>/s);
  });

  it('plainTextTemplate returns plain text output without HTML tags', () => {
    const text = plainTextTemplate('en', 'https://example.apex-os.com', 'Ren', 'Hi', 'Body text');

    expect(typeof text).toBe('string');
    expect(text).toContain('ApexOS');
    expect(text).not.toContain('<html>');
    expect(text).not.toContain('<body>');
    expect(text).toContain('Body text');
  });
});
