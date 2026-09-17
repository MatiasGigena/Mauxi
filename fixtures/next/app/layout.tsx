import type { Metadata } from "next";
import "./styles.css";

export const metadata: Metadata = { title: "Next proof fixture" };

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}<div id="portal" /></body></html>;
}
