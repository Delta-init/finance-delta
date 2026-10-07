import type { MetadataRoute } from "next";

/** Installable as an app (Add to Home Screen / Install); the service worker is public/app-sw.js. */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Delta Finance",
    short_name: "Finance",
    description: "Delta's finance portal",
    start_url: "/dashboard",
    scope: "/",
    display: "standalone",
    background_color: "#ffffff",
    theme_color: "#0f172a",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
