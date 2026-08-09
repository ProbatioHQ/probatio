import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  // Was still the scaffolding default. A tab reading "Create Next App" on a
  // product whose argument is that it is careful about detail is a bad first
  // impression and a free one to avoid.
  title: {
    default: "Probatio",
    template: "%s",
  },
  description:
    "Trade live Solana markets with practice money. Honest fills, and a record anyone can check.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
