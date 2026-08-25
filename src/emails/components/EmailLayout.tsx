import React from 'react';

interface EmailLayoutProps {
  locale: 'vi' | 'en';
  title: string;
  children: React.ReactNode;
  previewText?: string;
  unsubscribeUrl?: string;
}

const styles: Record<string, React.CSSProperties> = {
  body: {
    margin: 0,
    padding: 0,
    backgroundColor: '#161616',
    fontFamily:
      "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif",
    fontSize: 16,
    lineHeight: 1.6,
    color: '#E4E4E7',
  },
  preview: {
    display: 'none',
    maxHeight: 0,
    overflow: 'hidden',
    fontSize: 1,
    lineHeight: 1,
    opacity: 0,
    color: '#161616',
  },
  wrapper: {
    padding: '40px 16px',
  },
  container: {
    maxWidth: 600,
    margin: '0 auto',
    backgroundColor: '#F4F4F5',
    borderRadius: 12,
    overflow: 'hidden',
    color: '#161616',
  },
  header: {
    backgroundColor: '#161616',
    padding: '32px 40px',
    textAlign: 'center' as const,
  },
  logo: {
    margin: 0,
    fontSize: 22,
    fontWeight: 700,
    color: '#F4F4F5',
    letterSpacing: '0.05em',
    textTransform: 'uppercase' as const,
  },
  content: {
    padding: '40px',
  },
  footer: {
    padding: '24px 40px',
    borderTop: '1px solid #E4E4E7',
    textAlign: 'center' as const,
    fontSize: 13,
    color: '#71717A',
  },
  footerLink: {
    color: '#F97316',
    textDecoration: 'none',
  },
};

export function EmailLayout({
  locale,
  title,
  children,
  previewText,
  unsubscribeUrl,
}: EmailLayoutProps): JSX.Element {
  const brandName = locale === 'vi' ? 'ApexOS' : 'ApexOS';
  const footerText =
    locale === 'vi'
      ? '© 2026 ApexOS. Bảo lưu mọi quyền.'
      : '© 2026 ApexOS. All rights reserved.';
  const footerUnsubscribe =
    locale === 'vi' ? 'Hủy đăng ký' : 'Unsubscribe';

  return (
    <>
      {previewText && (
        <div style={styles.preview}>{previewText}</div>
      )}
      <div style={styles.body}>
        <div style={styles.wrapper}>
          <div style={styles.container}>
            <div style={styles.header}>
              <p style={styles.logo}>{brandName}</p>
            </div>
            <div style={styles.content}>
              <h1
                style={{
                  margin: '0 0 24px',
                  fontSize: 24,
                  fontWeight: 700,
                  color: '#161616',
                  lineHeight: 1.3,
                }}
              >
                {title}
              </h1>
              {children}
            </div>
            <div style={styles.footer}>
              <p style={{ margin: '0 0 8px' }}>{footerText}</p>
              {unsubscribeUrl && (
                <p style={{ margin: 0 }}>
                  <a
                    href={unsubscribeUrl}
                    style={styles.footerLink}
                  >
                    {footerUnsubscribe}
                  </a>
                </p>
              )}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
