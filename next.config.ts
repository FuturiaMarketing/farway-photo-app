/** @type {import('next').NextConfig} */
const nextConfig = {
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: '**', // Questo permette di caricare le immagini dal tuo sito, qualunque sia il dominio esatto
      },
    ],
  },
};

export default nextConfig;