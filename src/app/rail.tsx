"use client";

import Link from "next/link";
import { Suspense } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { AGENTS, DEPARTMENTS } from "@/lib/agents";

/** Black department rail — Mission Control's left navigation. */
function RailNav() {
  const pathname = usePathname();
  const dept = useSearchParams().get("dept");

  const counts = new Map<string, number>();
  for (const a of AGENTS) counts.set(a.department, (counts.get(a.department) || 0) + 1);

  if (pathname === "/login") return null;

  return (
    <aside className="rail">
      <Link href="/" className="wm">
        <em>Brigham Larson</em>
        <b>AGENTS</b>
      </Link>
      <nav>
        <Link href="/" className={pathname === "/" && !dept ? "on" : ""}>
          All departments<span>{AGENTS.length}</span>
        </Link>
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
