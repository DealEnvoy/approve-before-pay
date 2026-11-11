import type { Metadata } from "next";
import { Newsreader, Outfit } from "next/font/google";

import "./globals.css";

const outfit = Outfit({
  subsets: ["latin"],
  variable: "--font-outfit",
});

const newsreader = Newsreader({
  subsets: ["latin"],
  variable: "--font-newsreader",
});

export const metadata: Metadata = {
  title: "Approve before Pay",
  description: "An agent prepares a PayPal order. A person approves it before capture.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${outfit.variable} ${newsreader.variable}`}>
      <body>
        <noscript>This desk needs JavaScript so the review actions can call the server.</noscript>
        {children}
      </body>
    </html>
  );
}
