/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@delta/shared"],
  experimental: {
    // shared workspace is imported as TS source
    externalDir: true,
  },
};

export default nextConfig;
