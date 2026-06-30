#!/usr/bin/env node
/**
 * Generate mock admin session token for k6 load testing
 *
 * This creates a simple base64-encoded session payload that mimics
 * a Better Auth session cookie for admin users.
 *
 * Usage:
 *   node k6/generate-admin-token.js
 */

function generateMockAdminToken() {
  const payload = {
    userId: `admin-${Math.random().toString(36).substring(2, 10)}`,
    email: 'admin@apex-os.com',
    role: 'admin',
    exp: Date.now() + 3600000, // 1 hour from now
    iat: Date.now(),
  };

  // Simple base64 encoding (in production, this would be a proper JWT)
  return Buffer.from(JSON.stringify(payload)).toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

// Output token only (for scripting)
console.log(generateMockAdminToken());
