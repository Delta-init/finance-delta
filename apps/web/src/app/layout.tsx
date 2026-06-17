import "@/styles/globals.css";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import NextTopLoader from "nextjs-toploader";
import { Providers } from "@/providers";

export const metadata: Metadata = {
  title: "Delta Finance",
  description: "Internal business management system",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <NextTopLoader
          color="white"
            shadow="0 0 10px white, 0 0 5px white"
            height={4}
            showSpinner={false}
            easing="ease"
            speed={200} />
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
