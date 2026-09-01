import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "Words of Meaning",
  description: "Blind prompt-identification experiments for qualitative instructions",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <header className="site-header">
          <Link className="brand" href="/">Words of Meaning</Link>
          <span>Observable behavior, measured blind</span>
        </header>
        {children}
      </body>
    </html>
  );
}
