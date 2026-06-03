"use client";

import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { useSession } from "next-auth/react";
import {
  DollarSign, CreditCard, TrendingUp, TrendingDown, ArrowUpRight, ArrowDownRight,
  ScanLine, Eye, Sparkles, Loader2
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { PortfolioChart } from "@/components/charts/portfolio-chart";

// Mock data for price movers (to be fully dynamic later when cron jobs are active)
const priceMovers = [
  { name: "Charizard VSTAR", change: "+$12.40", percent: "+22.1%", trend: "up" as const, game: "Pokémon" },
  { name: "Force of Will", change: "+$8.75", percent: "+6.3%", trend: "up" as const, game: "MTG" },
  { name: "Ash Blossom", change: "-$2.10", percent: "-4.1%", trend: "down" as const, game: "Yu-Gi-Oh!" },
  { name: "Umbreon VMAX", change: "+$15.00", percent: "+8.9%", trend: "up" as const, game: "Pokémon" },
];

const fadeUp = {
  initial: { opacity: 0, y: 20 },
  animate: { opacity: 1, y: 0 },
};

function timeAgo(dateString: string) {
  const diff = Date.now() - new Date(dateString).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export default function DashboardPage() {
  const { data: session } = useSession();
  const [dashboardData, setDashboardData] = useState<any>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    if (!session?.user?.id || !(session as any).accessToken) return;
    
    fetch(`http://localhost:4000/dashboard`, {
      headers: {
        Authorization: `Bearer ${(session as any).accessToken}`,
      },
    })
      .then((res) => res.json())
      .then((json) => {
        if (json.success) {
          setDashboardData(json.data);
        }
      })
      .catch((err) => console.error("Failed to fetch dashboard:", err))
      .finally(() => setIsLoading(false));
  }, [session]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full min-h-[50vh]">
        <Loader2 className="h-8 w-8 text-aura-purple animate-spin" />
      </div>
    );
  }

  const stats = dashboardData?.stats || { collectionValue: 0, cardsOwned: 0 };
  const recentScans = dashboardData?.recentScans || [];

  const statCards = [
    {
      title: "Collection Value",
      value: `$${stats.collectionValue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
      change: "+$127.30",
      changePercent: "+3.1%",
      trend: "up" as const,
      icon: DollarSign,
    },
    {
      title: "Cards Owned",
      value: stats.cardsOwned.toString(),
      change: "+12",
      changePercent: "this week",
      trend: "up" as const,
      icon: CreditCard,
    },
    {
      title: "Top Gainer",
      value: "$89.99",
      change: "Charizard VMAX",
      changePercent: "+18.2%",
      trend: "up" as const,
      icon: TrendingUp,
    },
    {
      title: "Top Loser",
      value: "$12.50",
      change: "Dark Magician",
      changePercent: "-5.4%",
      trend: "down" as const,
      icon: TrendingDown,
    },
  ];

  return (
    <div className="p-4 sm:p-6 lg:p-8 space-y-6">
      {/* Header */}
      <motion.div {...fadeUp} transition={{ duration: 0.4 }}>
        <h1 className="text-2xl sm:text-3xl font-bold">Dashboard</h1>
        <p className="text-muted-foreground mt-1">Welcome back, {session?.user?.name?.split(' ')[0] || 'Collector'}. Here&apos;s your collection overview.</p>
      </motion.div>

      {/* Stats grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {statCards.map((stat, i) => (
          <motion.div
            key={stat.title}
            {...fadeUp}
            transition={{ duration: 0.4, delay: i * 0.08 }}
          >
            <Card className="glass border-border/50 card-hover">
              <CardContent className="p-5">
                <div className="flex items-center justify-between mb-3">
                  <p className="text-sm text-muted-foreground font-medium">{stat.title}</p>
                  <div className="h-8 w-8 rounded-lg bg-aura-purple/10 flex items-center justify-center">
                    <stat.icon className="h-4 w-4 text-aura-purple" />
                  </div>
                </div>
                <div className="text-2xl font-bold">{stat.value}</div>
                <div className="flex items-center gap-1.5 mt-1.5">
                  {stat.trend === "up" ? (
                    <ArrowUpRight className="h-3.5 w-3.5 text-emerald-400" />
                  ) : (
                    <ArrowDownRight className="h-3.5 w-3.5 text-red-400" />
                  )}
                  <span className={`text-xs font-medium ${stat.trend === "up" ? "text-emerald-400" : "text-red-400"}`}>
                    {stat.changePercent}
                  </span>
                  <span className="text-xs text-muted-foreground">{stat.change}</span>
                </div>
              </CardContent>
            </Card>
          </motion.div>
        ))}
      </div>

      {/* Portfolio chart */}
      <motion.div {...fadeUp} transition={{ duration: 0.4, delay: 0.35 }}>
        <Card className="glass border-border/50">
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <CardTitle className="text-base font-semibold">Portfolio Performance</CardTitle>
              <div className="flex gap-1">
                {["7D", "1M", "3M", "1Y", "ALL"].map((period) => (
                  <button
                    key={period}
                    className={`px-2.5 py-1 rounded-lg text-xs font-medium transition-colors ${
                      period === "1M"
                        ? "bg-aura-purple/15 text-aura-purple"
                        : "text-muted-foreground hover:text-foreground hover:bg-accent"
                    }`}
                  >
                    {period}
                  </button>
                ))}
              </div>
            </div>
          </CardHeader>
          <CardContent className="pb-4">
            <PortfolioChart />
          </CardContent>
        </Card>
      </motion.div>

      {/* Two column layout */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Recent Scans */}
        <motion.div {...fadeUp} transition={{ duration: 0.4, delay: 0.45 }}>
          <Card className="glass border-border/50">
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <CardTitle className="text-base font-semibold flex items-center gap-2">
                  <ScanLine className="h-4 w-4 text-aura-purple" />
                  Recent Scans
                </CardTitle>
                <Badge variant="secondary" className="text-xs">Latest</Badge>
              </div>
            </CardHeader>
            <CardContent className="pb-4">
              <div className="space-y-3">
                {recentScans.length === 0 ? (
                  <div className="text-center py-6 text-sm text-muted-foreground">
                    No scans yet. Try scanning a card!
                  </div>
                ) : (
                  recentScans.map((scan: any) => (
                    <div key={scan.id} className="flex items-center justify-between py-2 border-b border-border/50 last:border-0">
                      <div className="flex items-center gap-3 min-w-0">
                        <div className="h-9 w-9 rounded-lg bg-aura-purple/10 flex items-center justify-center shrink-0">
                          <Sparkles className="h-4 w-4 text-aura-purple" />
                        </div>
                        <div className="min-w-0">
                          <p className="text-sm font-medium truncate">{scan.name}</p>
                          <p className="text-xs text-muted-foreground">{scan.set} · {scan.game}</p>
                        </div>
                      </div>
                      <div className="text-right shrink-0 ml-3">
                        <p className="text-sm font-semibold">${scan.price?.toLocaleString(undefined, { minimumFractionDigits: 2 })}</p>
                        <p className="text-xs text-muted-foreground">{timeAgo(scan.createdAt)}</p>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </CardContent>
          </Card>
        </motion.div>

        {/* Price Movers */}
        <motion.div {...fadeUp} transition={{ duration: 0.4, delay: 0.55 }}>
          <Card className="glass border-border/50">
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <CardTitle className="text-base font-semibold flex items-center gap-2">
                  <Eye className="h-4 w-4 text-aura-purple" />
                  Price Movers
                </CardTitle>
                <Badge variant="secondary" className="text-xs">Today</Badge>
              </div>
            </CardHeader>
            <CardContent className="pb-4">
              <div className="space-y-3">
                {priceMovers.map((mover) => (
                  <div key={mover.name} className="flex items-center justify-between py-2 border-b border-border/50 last:border-0">
                    <div className="min-w-0">
                      <p className="text-sm font-medium truncate">{mover.name}</p>
                      <p className="text-xs text-muted-foreground">{mover.game}</p>
                    </div>
                    <div className="flex items-center gap-2 shrink-0 ml-3">
                      <Badge
                        variant="secondary"
                        className={`text-xs ${mover.trend === "up" ? "bg-emerald-400/10 text-emerald-400" : "bg-red-400/10 text-red-400"}`}
                      >
                        {mover.trend === "up" ? <ArrowUpRight className="h-3 w-3 mr-0.5" /> : <ArrowDownRight className="h-3 w-3 mr-0.5" />}
                        {mover.percent}
                      </Badge>
                      <span className="text-sm font-medium w-16 text-right">{mover.change}</span>
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </motion.div>
      </div>
    </div>
  );
}
