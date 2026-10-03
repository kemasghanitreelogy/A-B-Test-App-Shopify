import type { Metadata } from "next";
import { Fira_Sans, Fira_Code } from "next/font/google";
import { Toaster } from "@/components/ui/sonner";
import { LangProvider } from "@/components/lang-provider";
import { getLang } from "@/lib/i18n.server";
import "./globals.css";

const firaSans = Fira_Sans({
  variable: "--font-fira-sans",
  subsets: ["latin"],
  weight: ["300", "400", "500", "600", "700"],
});

const firaCode = Fira_Code({
  variable: "--font-fira-code",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
});

export const metadata: Metadata = {
  title: "Treelogy A/B",
  description: "Kontrol dan hasil A/B test halaman produk Treelogy",
};

/**
 * Skrip ini harus berjalan sinkron sebelum body dirender.
 * Kalau tidak, halaman sempat berkedip putih dulu sebelum tema gelap terpasang.
 */
const THEME_SCRIPT = `
try {
  var stored = localStorage.getItem("tl-theme");
  var dark = stored ? stored === "dark" : true;
  document.documentElement.classList.toggle("dark", dark);
} catch (e) {
  document.documentElement.classList.add("dark");
}
`;

export default async function RootLayout({ children }: LayoutProps<"/">) {
  const lang = await getLang();
  return (
    <html
      lang={lang}
      className={`${firaSans.variable} ${firaCode.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body className="min-h-full flex flex-col">
        <LangProvider lang={lang}>
          {children}
          <Toaster position="top-right" />
        </LangProvider>
      </body>
    </html>
  );
}
