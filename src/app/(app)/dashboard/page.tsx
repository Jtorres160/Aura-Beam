import { redirect } from "next/navigation";

// The SaaS-style dashboard was retired in the Collector's Instrument
// redesign (Phase 2). Its content lives on as /insights; this redirect
// keeps old bookmarks and deep links working.
export default function DashboardRedirect() {
  redirect("/insights");
}
