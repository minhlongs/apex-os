import React from 'react';

interface HeadingProps {
  level?: 1 | 2 | 3;
  children: React.ReactNode;
  align?: 'left' | 'center';
}

const headingStyles: Record<number, React.CSSProperties> = {
  1: {
    margin: '0 0 16px',
    fontSize: 28,
    fontWeight: 700,
    color: '#161616',
    lineHeight: 1.25,
  },
  2: {
    margin: '32px 0 12px',
    fontSize: 22,
    fontWeight: 700,
    color: '#161616',
    lineHeight: 1.3,
  },
  3: {
    margin: '24px 0 10px',
    fontSize: 18,
    fontWeight: 600,
    color: '#161616',
    lineHeight: 1.35,
  },
};

export function Heading({
  level = 2,
  children,
  align = 'left',
}: HeadingProps): JSX.Element {
  const Tag = `h${level}` as 'h1' | 'h2' | 'h3';

  return (
    <Tag
      style={{
        ...headingStyles[level],
        textAlign: align,
      }}
    >
      {children}
    </Tag>
  );
}
