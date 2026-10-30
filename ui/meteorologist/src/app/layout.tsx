/**
 * @file
 * The frame every page sits in: GUI Mellow's tokens and fonts, the
 * header with its navigation, and who you're acting as.
 *
 * When requests aren't being made as a signed-in person — fixtures or
 * a development kubeconfig — a bar across the top says so, so a
 * screenshot or a forgotten terminal can't be mistaken for the real
 * thing.
 */
import type { Metadata } from "next";
import Link from "next/link";
import { IBM_Plex_Mono, IBM_Plex_Sans, Space_Grotesk } from "next/font/google";
import { Announcement } from "gui-mellow/Announcement";
import { Container } from "gui-mellow/Container";
import { SiteHeader } from "gui-mellow/SiteHeader";
import { ThemeScript, ThemeToggle } from "gui-mellow/ThemeToggle";
import "gui-mellow/styles.scss";

import { ViewerMenu } from "@/components/ViewerMenu";
import { getViewer } from "@/lib/kube";
import styles from "./layout.module.scss";

const display = Space_Grotesk({ variable: "--font-display", subsets: ["latin"], weight: ["500", "600"] });
const body = IBM_Plex_Sans({ variable: "--font-body", subsets: ["latin"], weight: ["400", "500", "600"] });
const mono = IBM_Plex_Mono({ variable: "--font-mono", subsets: ["latin"], weight: ["400"] });

export const metadata: Metadata = {
  title: { default: "Meteorologist", template: "%s · Meteorologist" },
  description: "The Community Cloud web interface",
};

// Every page reads the cluster as the person asking, so none can be
// rendered ahead of time
export const dynamic = "force-dynamic";

// What the bar says in each development mode
const DEV_NOTICES = {
  fixtures: "Showing a pretend cluster held in memory. Changes last until the server restarts.",
  kubeconfig: "Acting as the user in METEOROLOGIST_KUBECONFIG, not as a signed-in person.",
} as const;

/**
 * @param props
 * @param props.children
 * @returns
 */
export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const viewer = await getViewer();

  return (
    <html lang="en" className={`${display.variable} ${body.variable} ${mono.variable}`} suppressHydrationWarning>
      <head>
        <ThemeScript />
      </head>
      <body>
        {viewer && viewer.mode !== "user" && (
          <Announcement label={viewer.mode === "fixtures" ? "Fixtures" : "Development"}>
            {DEV_NOTICES[viewer.mode]}
          </Announcement>
        )}
        <SiteHeader
          brand={
            <Link href="/" className={styles.brand}>
              Meteorologist
            </Link>
          }
          items={[
            { href: "/", label: "Overview" },
            { href: "/namespaces", label: "Namespaces" },
            { href: "/apps", label: "Applications" },
            { href: "/office", label: "Office" },
          ]}
          actions={
            <>
              {viewer && <ViewerMenu viewer={viewer} />}
              <ThemeToggle />
            </>
          }
        />
        <Container as="main" className={styles.main}>
          {children}
        </Container>
      </body>
    </html>
  );
}
