/** @type {import('next').NextConfig} */
const nextConfig = {
  webpack(config, { dev, isServer }) {
    // Mauxi development integration is inserted here.
    return config;
  },
};

export default nextConfig;
