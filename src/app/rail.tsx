"use client";

import Link from "next/link";
import { Suspense, useEffect, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { AGENTS, DEPARTMENTS } from "@/lib/agents";

/**
 * Navigation — black department rail on desktop, hamburger dropdown on
 * mobile (same pattern as the Super-CRM).
 */
function RailNav() {
  const pathname = usePathname();
  const dept = useSearchParams().get("dept");
  const [open, setOpen] = useState(false);

  // Close the mobile menu on any navigation.
  useEffect(() => {
    setOpen(false);
  }, [pathname, dept]);

  const counts = new Map<string, number>();
  for (const a of AGENTS) counts.set(a.department, (counts.get(a.department) || 0) + 1);

  if (pathname === "/login") return null;

  const links = (
    <nav>
      <Link href="/" className={pathname === "/" && !dept ? "on" : ""}>
        Fleet<span>{AGENTS.length}</span>
      </Link>
      <Link href="/activity" className={pathname === "/activity" ? "on" : ""}>
        Activity
      </Link>
      <div className="nav-label">Departments</div>
      {DEPARTMENTS.map((d) => (
        <Link
          key={d}
          href={`/?dept=${encodeURIComponent(d)}`}
          className={pathname === "/" && dept === d ? "on" : ""}
        >
          {d === "Admin & Customer Service" ? "Admin & CS" : d === "Accounting & Finance" ? "Finance" : d}
          <span>{counts.get(d) || 0}</span>
        </Link>
      ))}
    </nav>
  );

  return (
    <aside className="rail">
      <div className="rail-top">
        <Link href="/" className="wm">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/blp-logo.png" alt="Brigham Larson Pianos" className="logo" />
          <b>AGENT CONSOLE</b>
        </Link>
        <button
          className="burger"
          aria-label={open ? "Close menu" : "Open menu"}
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          {open ? "✕" : "☰"}
        </button>
      </div>
      <div className={`rail-links${open ? " open" : ""}`}>{links}</div>
      <div className="foot">heartbeats every 10 min<br />via the Leads Log</div>
    </aside>
  );
}

export default function Rail() {
  return (
    <Suspense fallback={<aside className="rail" />}>
      <RailNav />
    </Suspense>
  );
}
