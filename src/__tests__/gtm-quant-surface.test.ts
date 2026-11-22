import { QUANT_INSIGHT_ARTICLES, getQuantInsightBySlug } from '../data/quant-insights';
import {
  generateOrganizationJsonLd,
  generateSoftwareApplicationJsonLd,
  generateTechArticleJsonLd,
} from '../lib/seo/json-ld';
import sitemap from '../app/sitemap';
import robots from '../app/robots';
import enMessages from '../i18n/messages/en.json';
import viMessages from '../i18n/messages/vi.json';

function collectKeys(obj: Record<string, unknown>, prefix = ''): string[] {
  const keys: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      keys.push(...collectKeys(v as Record<string, unknown>, path));
    } else {
      keys.push(path);
    }
  }
  return keys.sort();
}

describe('GTM & Quant Surface Integration Tests', () => {
  describe('Bilingual i18n Key Parity & Translation Coverage', () => {
    it('maintains 100% key parity between en.json and vi.json', () => {
      const enKeys = collectKeys(enMessages as Record<string, unknown>);
      const viKeys = collectKeys(viMessages as Record<string, unknown>);
      expect(viKeys).toEqual(enKeys);
    });

    it('includes insights namespace and kucoin exchange in both locales', () => {
      expect(enMessages.insights.title).toBeTruthy();
      expect(viMessages.insights.title).toBeTruthy();
      expect(enMessages.deals.exchanges.kucoin).toBe('KuCoin');
      expect(viMessages.deals.exchanges.kucoin).toBe('KuCoin');
      expect(viMessages.nav.insights).toBe('Nghiên cứu Định lượng');
    });
  });

  describe('Quantitative Insights Catalog', () => {
    it('contains at least 3 bilingual articles with valid metadata', () => {
      expect(QUANT_INSIGHT_ARTICLES.length).toBeGreaterThanOrEqual(3);

      for (const article of QUANT_INSIGHT_ARTICLES) {
        expect(article.slug).toBeDefined();
        expect(article.title.en).toBeTruthy();
        expect(article.title.vi).toBeTruthy();
        expect(article.summary.en).toBeTruthy();
        expect(article.summary.vi).toBeTruthy();
        expect(article.sections.length).toBeGreaterThanOrEqual(2);
        expect(article.metricsHighlight.bps).toBeTruthy();
        expect(article.metricsHighlight.exchanges.length).toBeGreaterThanOrEqual(1);
        expect(article.metricsHighlight.settlement).toBeTruthy();
      }
    });

    it('resolves individual articles correctly by slug', () => {
      const slug = 'basis-point-fee-drag-quant-execution';
      const article = getQuantInsightBySlug(slug);
      expect(article).toBeDefined();
      expect(article?.slug).toBe(slug);
      expect(article?.category).toBe('microstructure');

      const nonexistent = getQuantInsightBySlug('nonexistent-slug');
      expect(nonexistent).toBeUndefined();
    });
  });

  describe('Technical SEO & Structured Data (JSON-LD)', () => {
    it('generates valid Organization JSON-LD', () => {
      const org = generateOrganizationJsonLd();
      expect(org['@context']).toBe('https://schema.org');
      expect(org['@type']).toBe('Organization');
      expect(org.name).toBe('ApexOS');
      expect(org.url).toBe('https://apex-os.agencyos-openclaw.workers.dev');
    });

    it('generates valid SoftwareApplication JSON-LD', () => {
      const app = generateSoftwareApplicationJsonLd();
      expect(app['@type']).toBe('SoftwareApplication');
      expect(app.applicationCategory).toBe('FinanceApplication');
      expect(app.url).toBe('https://apex-os.agencyos-openclaw.workers.dev/landing');
    });

    it('generates valid TechArticle JSON-LD for an article', () => {
      const article = QUANT_INSIGHT_ARTICLES[0];
      const techArticle = generateTechArticleJsonLd({
        slug: article.slug,
        title: article.title.en,
        description: article.summary.en,
        publishedAt: article.publishedAt,
        locale: 'en',
      });

      expect(techArticle['@context']).toBe('https://schema.org');
      expect(techArticle['@type']).toBe('TechArticle');
      expect(techArticle.headline).toBe(article.title.en);
      expect(techArticle.mainEntityOfPage['@id']).toBe(`https://apex-os.agencyos-openclaw.workers.dev/en/insights/${article.slug}`);
      expect(techArticle.inLanguage).toBe('en');
    });
  });

  describe('Sitemap & Robots Verification', () => {
    it('sitemap generates public localized routes and dynamic insights slugs', () => {
      const entries = sitemap();
      expect(entries.length).toBeGreaterThan(0);

      const urls = entries.map((e) => e.url);

      // Verifies public routes
      expect(urls).toContain('https://apex-os.agencyos-openclaw.workers.dev/vi');
      expect(urls).toContain('https://apex-os.agencyos-openclaw.workers.dev/en');
      expect(urls).toContain('https://apex-os.agencyos-openclaw.workers.dev/vi/deals');
      expect(urls).toContain('https://apex-os.agencyos-openclaw.workers.dev/en/deals');
      expect(urls).toContain('https://apex-os.agencyos-openclaw.workers.dev/vi/insights');
      expect(urls).toContain('https://apex-os.agencyos-openclaw.workers.dev/en/insights');
      expect(urls).toContain('https://apex-os.agencyos-openclaw.workers.dev/vi/terminal');
      expect(urls).toContain('https://apex-os.agencyos-openclaw.workers.dev/en/terminal');

      // Verifies insights dynamic slugs are present in sitemap
      for (const article of QUANT_INSIGHT_ARTICLES) {
        expect(urls).toContain(`https://apex-os.agencyos-openclaw.workers.dev/vi/insights/${article.slug}`);
        expect(urls).toContain(`https://apex-os.agencyos-openclaw.workers.dev/en/insights/${article.slug}`);
      }

      // Verifies admin and internal paths are strictly NOT leaked in sitemap
      for (const url of urls) {
        expect(url).not.toContain('/admin');
        expect(url).not.toContain('/api');
        expect(url).not.toContain('/dashboard');
      }
    });

    it('robots.txt disallows sensitive API and admin endpoints', () => {
      const config = robots();
      expect(config.sitemap).toBe('https://apex-os.agencyos-openclaw.workers.dev/sitemap.xml');

      const rules = Array.isArray(config.rules) ? config.rules[0] : config.rules;
      expect(rules.userAgent).toBe('*');
      expect(rules.allow).toContain('/');
      expect(rules.disallow).toEqual(
        expect.arrayContaining([
          '/api/',
          '/admin/',
          '/vi/admin/',
          '/en/admin/',
          '/vi/dashboard/',
          '/en/dashboard/',
        ])
      );
    });
  });
});
