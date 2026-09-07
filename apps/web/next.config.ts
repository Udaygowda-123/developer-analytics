import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // `@pulse/shared` ships TypeScript source for its type entrypoint; Next has
  // to compile it rather than assume a pre-built CommonJS bundle.
  transpilePackages: ['@pulse/shared'],
  eslint: {
    // Lint is a separate CI step; a lint error should not block a build.
    ignoreDuringBuilds: true,
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'X-Frame-Options', value: 'DENY' },
        ],
      },
    ];
  },
};

export default nextConfig;
