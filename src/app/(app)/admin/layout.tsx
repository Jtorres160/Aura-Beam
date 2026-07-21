import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { checkAdmin } from "@/lib/admin-auth";

// Server-side gate for the whole /admin subtree. The proxy middleware only
// enforces *authentication* on /admin (any logged-in user passes); role is
// enforced here, and again on every admin API route. This runs before the
// client page renders, so a non-admin is redirected away rather than shown the
// page shell while the API quietly 403s behind it — the UI is never the guard.
export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();
  const gate = checkAdmin(session);
  if (!gate.ok) {
    // Not signed in at all → login; signed in but not admin → back into the app.
    redirect(gate.status === 401 ? "/login" : "/insights");
  }
  return <>{children}</>;
}
