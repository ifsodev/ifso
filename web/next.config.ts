import type { NextConfig } from "next";
import { SECRET_STATIC_HEADERS } from "./src/lib/ifso/csp";

const nextConfig: NextConfig = {
  // Keep the development-only route indicator out of the site preview.
  devIndicators: false,
  // Drop the `X-Powered-By: Next.js` response header.
  poweredByHeader: false,

  compiler: {
    // Strip `console.*` from production bundles, keeping error/warn for
    // monitoring. Left on in dev so logs stay available.
    removeConsole:
      process.env.NODE_ENV === "production"
        ? { exclude: ["error", "warn"] }
        : false,
  },

  // The claim page and /link hold a secret: no caching, no referrer, framing denied. The nonce-based script policy is set
  // per request in src/proxy.ts (it needs a fresh nonce each time).
  async headers() {
    const list = Object.entries(SECRET_STATIC_HEADERS).map(([key, value]) => ({ key, value }));
    return [
      { source: "/c/:id", headers: list },
      { source: "/link", headers: list },
    ];
  },

  // Reown AppKit's ethers helpers import Base Account, a server-heavy SDK that drags in optional payment packages. The
  // site never offers that wallet type, so it is pointed at an empty stand-in.
  turbopack: {
    resolveAlias: {
      "@base-org/account": "./src/vendor/empty-module.ts",
    },
  },

  images: {
    // Modern formats — smaller than JPEG/PNG; the browser picks what it supports.
    formats: ["image/avif", "image/webp"],
    // Breakpoints `next/image` uses to build `srcset`. `deviceSizes` covers
    // full-width images (aligned with the adaptive-grid breakpoints + retina);
    // `imageSizes` covers smaller, fixed-width images and icons.
    deviceSizes: [360, 640, 768, 1024, 1280, 1440, 1920, 2560],
    imageSizes: [16, 32, 48, 64, 96, 128, 256, 384],
  },

  // React Compiler (automatic memoisation) is an opt-in performance win.
  // It requires the `babel-plugin-react-compiler` dev dependency and routes
  // the build through Babel — enable once installed:
  // reactCompiler: true,
};

export default nextConfig;
