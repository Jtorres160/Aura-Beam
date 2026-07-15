import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { auth } from "@/auth";
// The scheduler's source of truth. Imported rather than retyped so a schedule
// shown here cannot drift from the schedule Vercel actually runs.
import vercelConfig from "../../../../../vercel.json";

/**
 * "Reachable" means the dependency answered a probe just now.
 * "Unreachable" means the probe ran and failed.
 * "Unknown" means no probe was performed — never render it as either of the above.
 */
export type HealthStatus = "Reachable" | "Unreachable" | "Unknown";

export interface HealthCheck {
  name: string;
  status: HealthStatus;
  /** Measured round-trip of the probe. Null whenever there is no measurement. */
  latencyMs: number | null;
}

export interface ScheduledJob {
  name: string;
  path: string;
  schedule: string;
  /**
   * Always null today: neither cron writes a run record. A run must never be
   * inferred from downstream side effects — PriceHistory.createdAt is a
   * last-write time, not a last-execution time, and a job that runs and updates
   * nothing leaves no trace at all. This stays null until an execution record
   * exists to read.
   */
  lastExecution: null;
}

/** Human labels for cron paths. A path with no label renders as itself. */
const JOB_LABELS: Record<string, string> = {
  "/api/cron/update-prices": "Price History Update",
  "/api/cron/analyze-scans": "Scan Analysis",
};

/**
 * Spells out the daily `m h * * *` shape only. Any other expression renders raw
 * rather than as a guess at its meaning.
 */
function describeSchedule(expression: string): string {
  const match = /^(\d{1,2}) (\d{1,2}) \* \* \*$/.exec(expression);
  if (!match) return expression;
  const [, minute, hour] = match;
  return `Daily — ${hour.padStart(2, "0")}:${minute.padStart(2, "0")} UTC`;
}

function readScheduledJobs(): ScheduledJob[] {
  const crons = vercelConfig.crons ?? [];
  return crons.map((cron) => ({
    name: JOB_LABELS[cron.path] ?? cron.path,
    path: cron.path,
    schedule: describeSchedule(cron.schedule),
    lastExecution: null,
  }));
}

/** Probes the database with a real query. Reports the failure rather than throwing. */
async function checkDatabase(): Promise<HealthCheck> {
  const startedAt = performance.now();
  try {
    await prisma.$queryRaw`SELECT 1`;
    return {
      name: "Database",
      status: "Reachable",
      latencyMs: Math.round(performance.now() - startedAt),
    };
  } catch (error) {
    console.error("Admin stats: database health probe failed:", error);
    return { name: "Database", status: "Unreachable", latencyMs: null };
  }
}

export async function GET() {
  try {
    const session = await auth();
    // In a real app, verify if session.user.role === "ADMIN"
    if (!session?.user?.id) {
      return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
    }

    // Probed independently of the counts below so that a database failure
    // renders as "Unreachable" instead of collapsing the whole response into a
    // 500 that tells the operator nothing.
    const database = await checkDatabase();

    // Counts fail as null, never as 0 — a zero here would be a fabricated
    // measurement indistinguishable from an empty table.
    let counts: { totalUsers: number; totalScans: number; cardsInDb: number } | null = null;
    try {
      const [totalUsers, totalScans, cardsInDb] = await Promise.all([
        prisma.user.count(),
        prisma.scanHistory.count(),
        prisma.card.count(),
      ]);
      counts = { totalUsers, totalScans, cardsInDb };
    } catch (error) {
      console.error("Admin stats: counts unavailable:", error);
    }

    return NextResponse.json({
      success: true,
      data: {
        totalUsers: counts?.totalUsers ?? null,
        totalScans: counts?.totalScans ?? null,
        cardsInDb: counts?.cardsInDb ?? null,
        // Null, not a number: we do not log external API calls, so we cannot
        // report them. This used to be `totalScans * 1.5 + 342` — a fabricated
        // figure that looked like a measurement and would have been read as one.
        // An absent metric must render as absent (see telemetry-analysis.ts:
        // "a provider we have no records for must never report 0ms"). When a
        // request log exists, this becomes a count; until then it stays null.
        apiRequests: null,
        // Only real dependencies appear here. Redis and Meilisearch are
        // docker-compose containers with no client installed and no runtime
        // usage — they were removed rather than reported on.
        health: { database },
        jobs: readScheduledJobs(),
      },
    });
  } catch (error) {
    console.error("Admin stats error:", error);
    return NextResponse.json(
      { success: false, message: "Failed to fetch admin stats" },
      { status: 500 }
    );
  }
}
