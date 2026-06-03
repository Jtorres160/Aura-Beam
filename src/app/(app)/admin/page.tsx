"use client";

import { motion } from "framer-motion";
import { Shield, Users, ScanLine, Database, Activity, Server, BarChart3 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";

const stats = [
  { label: "Total Users", value: "12,847", icon: Users, change: "+324 this week" },
  { label: "Total Scans", value: "89,421", icon: ScanLine, change: "+2,140 today" },
  { label: "Cards in DB", value: "52,381", icon: Database, change: "Last sync: 5m ago" },
  { label: "API Requests", value: "1.2M", icon: Activity, change: "This month" },
];

const jobs = [
  { name: "Price Sync — TCGPlayer", status: "running", lastRun: "2m ago", nextRun: "13m" },
  { name: "Price Sync — Scryfall", status: "idle", lastRun: "14m ago", nextRun: "1m" },
  { name: "Price Sync — PokéAPI", status: "idle", lastRun: "12m ago", nextRun: "3m" },
  { name: "Card DB Update", status: "completed", lastRun: "1h ago", nextRun: "23h" },
  { name: "Cache Cleanup", status: "completed", lastRun: "30m ago", nextRun: "30m" },
];

const statusColors: Record<string, string> = {
  running: "bg-emerald-400/10 text-emerald-400",
  idle: "bg-yellow-400/10 text-yellow-400",
  completed: "bg-blue-400/10 text-blue-400",
  failed: "bg-red-400/10 text-red-400",
};

const fadeUp = { initial: { opacity: 0, y: 20 }, animate: { opacity: 1, y: 0 } };

export default function AdminPage() {
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
                <div className="text-2xl font-bold">{stat.value}</div>
                <p className="text-xs text-muted-foreground mt-1">{stat.change}</p>
              </CardContent>
            </Card>
          </motion.div>
        ))}
      </div>

      {/* System health */}
      <motion.div {...fadeUp} transition={{ duration: 0.4, delay: 0.35 }}>
        <Card className="glass border-border/50">
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Server className="h-4 w-4 text-aura-purple" />
              System Health
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {[
              { name: "API Server", value: 98, status: "Healthy" },
              { name: "Database", value: 72, status: "Normal" },
              { name: "Redis Cache", value: 45, status: "Normal" },
              { name: "Meilisearch", value: 89, status: "Healthy" },
            ].map((s) => (
              <div key={s.name} className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">{s.name}</span>
                  <div className="flex items-center gap-2">
                    <Badge variant="secondary" className="text-xs bg-emerald-400/10 text-emerald-400">{s.status}</Badge>
                    <span className="text-xs text-muted-foreground">{s.value}%</span>
                  </div>
                </div>
                <Progress value={s.value} className="h-1.5 bg-accent [&>div]:gradient-bg" />
              </div>
            ))}
          </CardContent>
        </Card>
      </motion.div>

      {/* Background Jobs */}
      <motion.div {...fadeUp} transition={{ duration: 0.4, delay: 0.45 }}>
        <Card className="glass border-border/50">
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <BarChart3 className="h-4 w-4 text-aura-purple" />
              Background Jobs
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {jobs.map((job) => (
                <div key={job.name} className="flex items-center justify-between py-2 border-b border-border/50 last:border-0">
                  <div>
                    <p className="text-sm font-medium">{job.name}</p>
                    <p className="text-xs text-muted-foreground">Last run: {job.lastRun}</p>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-xs text-muted-foreground">Next: {job.nextRun}</span>
                    <Badge variant="secondary" className={`text-xs ${statusColors[job.status]}`}>{job.status}</Badge>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </motion.div>
    </div>
  );
}
