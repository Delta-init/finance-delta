import "@/styles/globals.css";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import NextTopLoader from "nextjs-toploader";
import { Providers } from "@/providers";
import { PwaRegister } from "@/components/PwaRegister";

export const metadata: Metadata = {
  title: "Delta Finance",
  description: "Internal business management system",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    // data-embed: this is the side page's frame (components/split-view/side-page.tsx) — set before the first paint, so
    // the menu and top bar never flash in it (globals.css hides them).
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: "try{if(window.name==='finance-pane')document.documentElement.setAttribute('data-embed','')}catch(e){}" }} />
      </head>
      <body>
        <NextTopLoader
          color="white"
            shadow="0 0 10px white, 0 0 5px white"
            height={4}
            showSpinner={false}
            easing="ease"
            speed={200} />
        <Providers>{children}</Providers>
        <PwaRegister />
      </body>
    </html>
  );
}
