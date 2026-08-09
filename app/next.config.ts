import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // @probatio/sim ships raw TypeScript rather than a build artifact, so the
  // fill engine has exactly one compiled form and the tests, the replay
  // harness in step 11 and the running app all execute identical code.
  transpilePackages: ['@probatio/sim', '@probatio/db', '@probatio/auth'],
};

export default nextConfig;
