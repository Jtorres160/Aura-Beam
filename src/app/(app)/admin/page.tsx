"use client";

import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { Shield, Users, ScanLine, Database, Activity, Server, BarChart3 } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

interface Stat {
  label: string;
  value: string;
  icon: LucideIcon;
  change: string;
  /** Render the value as an absence, not a figure — see the API Requests tile. */
  muted?: boolean;
}

/**
 * "Reachable" means the dependency answered a probe just now.
 * "Unreachable" means the probe ran and failed.
 * "Unknown" means no probe was performed — an unobserved dependency must never
 * be drawn as either healthy or failed.
 */
type HealthStatus = "Reachable" | "Unreachable" | "Unknown";

interface HealthRow {
  name: string;
  status: HealthStatus;
  latencyMs: number | null;
}

interface ScheduledJob {
  name: string;
  path: string;
  schedule: string;
  lastExecution: null;
}

// Values while the request is in flight. Every figure is an ellipsis and every
// status is a probe that has not reported yet — nothing here can be misread as
// a measurement.
const defaultStats: Stat[] = [
  { label: "Total Users", value: "...", icon: Users, change: "Loading..." },
  { label: "Total Scans", value: "...", icon: ScanLine, change: "Loading..." },
  { label: "Cards in DB", value: "...", icon: Database, change: "Loading..." },
  { label: "API Requests", value: "...", icon: Activity, change: "Loading..." },
];

/** A count we could not read renders as unknown — never as zero. */
function countStat(
  label: string,
  value: number | null | undefined,
  icon: LucideIcon,
  change: string
): Stat {
  return value == null
    ? { label, value: "Unknown", icon, change: "Not readable", muted: true }
    : { label, value: value.toLocaleString(), icon, change };
}

const statusStyles: Record<HealthStatus, string> = {
  Reachable: "bg-emerald-400/10 text-emerald-400",
  Unreachable: "bg-red-400/10 text-red-400",
  Unknown: "bg-muted text-muted-foreground",
};

const fadeUp = { initial: { opacity: 0, y: 20 }, animate: { opacity: 1, y: 0 } };

export default function AdminPage() {
  const [stats, setStats] = useState(defaultStats);
  // Null until the request settles, so the UI can say "checking" rather than
  // assert a state it has not observed.
  const [health, setHealth] = useState<HealthRow[] | null>(null);
  const [jobs, setJobs] = useState<ScheduledJob[] | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      // This request is itself the API Server observation.
      const startedAt = performance.now();
      let apiServer: HealthRow;

      try {
        const res = await fetch("/api/admin/stats");
        // It answered, so it is reachable — even on a 500. What it answered
        // with is a separate question, handled below.
        apiServer = {
          name: "API Server",
          status: "Reachable",
          latencyMs: Math.round(performance.now() - startedAt),
        };

        const json = await res.json();
        if (cancelled) return;

        if (json.success && json.data) {
          const data = json.data;
          setStats([
            countStat("Total Users", data.totalUsers, Users, "Registered accounts"),
            countStat("Total Scans", data.totalScans, ScanLine, "Cards identified"),
            countStat("Cards in DB", data.cardsInDb, Database, "Cached in our system"),
            // apiRequests is null until a request log exists — render the
            // absence rather than a number. `== null` guards the metric going
            // absent again later; toLocaleString() on null would throw.
            data.apiRequests == null
              ? { label: "API Requests", value: "Unavailable", icon: Activity, change: "Telemetry not collected", muted: true }
              : { label: "API Requests", value: data.apiRequests.toLocaleString(), icon: Activity, change: "Lifetime external hits" },
          ]);
          setHealth([apiServer, data.health.database]);
          setJobs(data.jobs);
          return;
        }

        // The server answered but carried no data (401, 500). We observed the
        // API Server; we observed nothing about the database behind it.
        setStats([
          countStat("Total Users", null, Users, ""),
          countStat("Total Scans", null, ScanLine, ""),
          countStat("Cards in DB", null, Database, ""),
          countStat("API Requests", null, Activity, ""),
        ]);
        setHealth([apiServer, { name: "Database", status: "Unknown", latencyMs: null }]);
        setJobs(null);
      } catch (err) {
        console.error(err);
        if (cancelled) return;
        // No response at all: the API Server probe failed, and the database was
        // never probed — unknown, not unreachable.
        setStats([
          countStat("Total Users", null, Users, ""),
          countStat("Total Scans", null, ScanLine, ""),
          countStat("Cards in DB", null, Database, ""),
          countStat("API Requests", null, Activity, ""),
        ]);
        setHealth([
          { name: "API Server", status: "Unreachable", latencyMs: null },
          { name: "Database", status: "Unknown", latencyMs: null },
        ]);
        setJobs(null);
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="p-4 sm:p-6 lg:p-8 space-y-6">
      <motion.div {...fadeUp} transition={{ duration: 0.4 }}>
        <h1 className="text-2xl sm:text-3xl font-bold flex items-center gap-2">
          <Shield className="h-6 w-6 text-aura-purple" />
          Admin Panel
        </h1>
        <p className="text-muted-foreground mt-1">System overview and management.</p>
      </motion.div>

      {/* Stats */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {stats.map((stat, i) => (
          <motion.div key={stat.label} {...fadeUp} transition={{ duration: 0.4, delay: i * 0.08 }}>
            <Card className="glass border-border/50 card-hover">
              <CardContent className="p-5">
                <div className="flex items-center justify-between mb-3">
                  <p className="text-sm text-muted-foreground font-medium">{stat.label}</p>
                  <stat.icon className="h-4 w-4 text-aura-purple" />
                </div>
                <div className={stat.muted ? "text-2xl font-medium text-muted-foreground/60" : "text-2xl font-bold"}>{stat.value}</div>
                <p className="text-xs text-muted-foreground mt-1">{stat.change}</p>
              </CardContent>
            </Card>
          </motion.div>
        ))}
      </div>

      {/* System — only dependencies this application actually talks to, each
          reporting a probe result rather than a percentage of nothing. */}
      <motion.div {...fadeUp} transition={{ duration: 0.4, delay: 0.35 }}>
        <Card className="glass border-border/50">
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Server className="h-4 w-4 text-aura-purple" />
              System
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {health === null ? (
              <p className="text-sm text-muted-foreground">Checking...</p>
            ) : (
              health.map((row) => (
                <div key={row.name} className="flex items-center justify-between py-2 border-b border-border/50 last:border-0">
                  <span className="text-sm font-medium">{row.name}</span>
                  <div className="flex items-center gap-3">
                    <span className="text-xs text-muted-foreground">
                      {row.latencyMs == null ? "No latency measured" : `${row.latencyMs} ms`}
                    </span>
                    <Badge variant="secondary" className={`text-xs ${statusStyles[row.status]}`}>
                      {row.status}
                    </Badge>
                  </div>
                </div>
              ))
            )}
          </CardContent>
        </Card>
      </motion.div>

      {/* Scheduled Jobs — schedules come from vercel.json. No run history is
          stored, and a run is never inferred from downstream writes. */}
      <motion.div {...fadeUp} transition={{ duration: 0.4, delay: 0.45 }}>
        <Card className="glass border-border/50">
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <BarChart3 className="h-4 w-4 text-aura-purple" />
              Scheduled Jobs
            </CardTitle>
          </CardHeader>
          <CardContent>
            {jobs === null ? (
              <p className="text-sm text-muted-foreground">Schedules unavailable.</p>
            ) : jobs.length === 0 ? (
              <p className="text-sm text-muted-foreground">No jobs scheduled.</p>
            ) : (
              <div className="space-y-3">
                {jobs.map((job) => (
                  <div key={job.path} className="flex items-start justify-between py-2 border-b border-border/50 last:border-0">
                    <div>
                      <p className="text-sm font-medium">{job.name}</p>
                      <p className="text-xs text-muted-foreground">{job.schedule}</p>
                    </div>
                    <span className="text-xs text-muted-foreground/60">No execution records stored</span>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </motion.div>
    </div>
  );
}
