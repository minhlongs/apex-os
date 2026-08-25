import React from 'react';

interface ButtonProps {
  href: string;
  children?: React.ReactNode;
  variant?: 'primary' | 'secondary';
}

const buttonStyles: Record<string, React.CSSProperties> = {
  primary: {
    display: 'inline-block',
    padding: '12px 24px',
    backgroundColor: '#F97316',
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: 600,
    lineHeight: 1.4,
    textDecoration: 'none',
    borderRadius: 10,
    border: 'none',
    textAlign: 'center' as const,
  },
  secondary: {
    display: 'inline-block',
    padding: '12px 24px',
    backgroundColor: 'transparent',
    color: '#161616',
    fontSize: 15,
    fontWeight: 600,
    lineHeight: 1.4,
    textDecoration: 'none',
    borderRadius: 10,
    border: '2px solid #E4E4E7',
    textAlign: 'center' as const,
  },
};

export function Button({ href, children, variant = 'primary' }: ButtonProps): JSX.Element {
  return (
    <a
      href={href}
      style={{
        ...buttonStyles[variant],
        ...(variant === 'primary' ? {} : { color: '#161616' }),
      }}
      rel="noopener noreferrer"
    >
      {children}
    </a>
  );
}
