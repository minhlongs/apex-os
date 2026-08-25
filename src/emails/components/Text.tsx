import React from 'react';

interface TextProps {
  size?: 'sm' | 'md' | 'lg';
  children: React.ReactNode;
  color?: string;
  align?: 'left' | 'center';
}

const textStyles: Record<string, React.CSSProperties> = {
  sm: {
    margin: '0 0 12px',
    fontSize: 14,
    lineHeight: 1.6,
    color: '#3F3F46',
  },
  md: {
    margin: '0 0 14px',
    fontSize: 16,
    lineHeight: 1.6,
    color: '#18181B',
  },
  lg: {
    margin: '0 0 16px',
    fontSize: 18,
    lineHeight: 1.5,
    color: '#18181B',
    fontWeight: 500,
  },
};

export function Text({
  size = 'md',
  children,
  color,
  align = 'left',
}: TextProps): JSX.Element {
  const base = textStyles[size];

  return (
    <p
      style={{
        ...base,
        ...(color ? { color } : {}),
        textAlign: align,
      }}
    >
      {children}
    </p>
  );
}
