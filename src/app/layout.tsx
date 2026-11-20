import type { Metadata } from "next";
import { Archivo } from "next/font/google";
import { SolanaProvider } from "@/components/solana-provider";
import "./globals.css";

/** Archivo variable font with its width axis, used for every piece of text. */
const archivo = Archivo({
  variable: "--font-archivo",
  subsets: ["latin"],
  axes: ["wdth"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "Ladder Hedge",
  description:
    "Hedge a crypto holding with the cheapest basket of Gemini price-ladder contracts.",
};

/**
 * Root layout shared by every route. Wraps every page in the Solana connection and
 * wallet providers so any page can read the wallet.
 *
 * @param {Readonly<{ children: React.ReactNode }>} props - Layout props.
 * @param {React.ReactNode} props.children - The active route's content.
 * @returns {JSX.Element} The HTML document shell.
 */
export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${archivo.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col bg-fog text-ink">
        <SolanaProvider>{children}</SolanaProvider>
      </body>
    </html>
  );
}
