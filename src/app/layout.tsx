import type { Metadata } from "next";
import "./globals.css";
import Rail from "./rail";

export const metadata: Metadata = {
  title: "BLP Agents — Mission Control",
  description: "Brigham Larson Pianos agent console: roster, fleet health, and per-agent consoles for the BLP digital team.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="redbar" />
        <div className="shell">
          <Rail />
          <main className="content">{children}</main>
        </div>
        {/* Shared BLP 💡 suggestion box (hosted by the sales app). */}
        <script src="https://blpsalesapp.netlify.app/suggest.js" defer data-app="Agent App" />
      </body>
    </html>
  );
}
