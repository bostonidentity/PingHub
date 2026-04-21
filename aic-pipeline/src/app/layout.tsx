import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { BusyProvider } from "@/hooks/useBusyState";
import { NavBar } from "@/components/NavBar";
import { DialogProvider } from "@/components/ConfirmDialog";
import { GlobalJobBanner } from "@/components/GlobalJobBanner";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "AIC Config Pipeline",
  description: "Ping Advanced Identity Cloud Configuration Pipeline UI",
};

// Every page reads per-request filesystem state (tenant configs, history,
// logs, git status). Opt the whole app out of static generation so pages
// re-render on each request in `next start`.
export const dynamic = "force-dynamic";

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="min-h-full bg-slate-50 text-slate-900 antialiased flex flex-col">
        <BusyProvider>
          <DialogProvider>
          <NavBar />
          <GlobalJobBanner />
          <main className="flex-1 px-6 sm:px-10 lg:px-16 py-10 w-full max-w-[1600px] mx-auto">
            {children}
          </main>
          <footer className="mt-auto border-t border-slate-200/60 bg-white">
            <div className="max-w-[1600px] mx-auto px-6 sm:px-10 lg:px-16 py-4 text-xs text-slate-500 flex items-center justify-between">
              <span>
                &copy; {new Date().getFullYear()} <span className="font-semibold text-slate-700">Boston Identity</span>
              </span>
              <span className="text-slate-400">AIC Config Pipeline</span>
            </div>
          </footer>
          </DialogProvider>
        </BusyProvider>
      </body>
    </html>
  );
}
