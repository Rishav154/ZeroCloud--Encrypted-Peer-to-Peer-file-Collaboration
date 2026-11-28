import type { Metadata } from "next";
import "./globals.css";
import { NearbyProvider } from "../components/nearby/NearbyProvider";

export const metadata: Metadata = {
  title: "ZeroCloud",
  description: "ZeroCloud signalling connection demo",
};

export const dynamic = "force-dynamic";

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body><NearbyProvider>{children}</NearbyProvider></body>
    </html>
  );
}
