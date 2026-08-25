const withNextIntl = require('next-intl/plugin')('./src/i18n/request.ts');

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  typescript: {
    ignoreBuildErrors: true,
  },
  images: {
    unoptimized: true,
  },
};

const path = require('path');

// Exclude mobile app from Next.js build
nextConfig.experimental = {
  ...nextConfig.experimental,
  turbopack: {
    resolveAlias: {
      '^expo-router$': path.resolve(__dirname, 'mobile/node_modules/expo-router'),
    },
  },
};

module.exports = withNextIntl(nextConfig);