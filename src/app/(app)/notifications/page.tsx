"use client";

import { useEffect, useState } from "react";
import { useSession } from "next-auth/react";
import { motion, AnimatePresence } from "framer-motion";
import { Bell, Check, TrendingUp, TrendingDown, Loader2 } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export default function NotificationsPage() {
  const { data: session } = useSession();
  const [notifications, setNotifications] = useState<any[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    if (!session?.user?.id || !(session as any).accessToken) return;
    fetchNotifications();
  }, [session]);

  const fetchNotifications = async () => {
    try {
      const res = await fetch("/api/notifications");
      const json = await res.json();
      if (json.success) {
        setNotifications(json.data);
      }
    } catch (err) {
      console.error(err);
    } finally {
      setIsLoading(false);
    }
  };

  const markAsRead = async (id?: string) => {
    try {
      await fetch("/api/notifications", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(id ? { notificationId: id } : {}),
      });
      setNotifications(prev =>
        prev.map(n => (id ? (n.id === id ? { ...n, read: true } : n) : { ...n, read: true }))
      );
    } catch (err) {
      console.error(err);
    }
  };

  if (isLoading) {
    return (
      <div className="p-8 flex items-center justify-center h-full">
        <Loader2 className="h-8 w-8 animate-spin text-aura-purple" />
      </div>
    );
  }

  const unreadCount = notifications.filter(n => !n.read).length;

  return (
    <div className="p-4 sm:p-6 lg:p-8 space-y-8 max-w-4xl mx-auto">
      {/* Header */}
      <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4 }} className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-3 mb-2">
            <div className="p-2.5 rounded-xl bg-blue-500/10 border border-blue-500/20">
              <Bell className="h-6 w-6 text-blue-500" />
            </div>
            <h1 className="text-2xl sm:text-3xl font-bold">Notifications</h1>
          </div>
          <p className="text-muted-foreground">Stay updated on your price alerts and collection.</p>
        </div>
        
        {unreadCount > 0 && (
          <Button variant="outline" onClick={() => markAsRead()} className="hidden sm:flex items-center gap-2">
            <Check className="h-4 w-4" />
            Mark all as read
          </Button>
        )}
      </motion.div>

      {/* Empty State */}
      {notifications.length === 0 && (
        <motion.div 
          initial={{ opacity: 0, scale: 0.95 }} 
          animate={{ opacity: 1, scale: 1 }}
          className="flex flex-col items-center justify-center py-20 text-center glass rounded-3xl border-border/50"
        >
          <div className="w-20 h-20 rounded-full bg-blue-500/10 flex items-center justify-center mb-6">
            <Bell className="h-8 w-8 text-blue-500/50" />
          </div>
          <h2 className="text-xl font-semibold mb-2">You're all caught up!</h2>
          <p className="text-muted-foreground mb-8 max-w-sm">
            We'll notify you here when your tracked cards hit your target prices.
          </p>
        </motion.div>
      )}

      {/* List */}
      <div className="space-y-4">
        <AnimatePresence>
          {notifications.map((notif, i) => {
            const isAlert = notif.type === "price_alert";
            const isUp = notif.message.includes("risen above");
            
            return (
              <motion.div
                key={notif.id}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.95 }}
                transition={{ duration: 0.25, delay: i * 0.05 }}
              >
                <Card className={cn(
                  "border-border/50 overflow-hidden relative group transition-all duration-300",
                  notif.read ? "bg-card/30" : "glass shadow-md",
                  !notif.read && isUp ? "shadow-[0_0_15px_rgba(16,185,129,0.1)]" : "",
                  !notif.read && !isUp ? "shadow-[0_0_15px_rgba(239,68,68,0.1)]" : ""
                )}>
                  <CardContent className="p-4 sm:p-5 flex items-start gap-4">
                    <div className={cn(
                      "p-3 rounded-full shrink-0",
                      isAlert && isUp ? "bg-emerald-500/10 text-emerald-500" : "",
                      isAlert && !isUp ? "bg-red-500/10 text-red-500" : "",
                      !isAlert ? "bg-blue-500/10 text-blue-500" : ""
                    )}>
                      {isAlert && isUp ? <TrendingUp className="h-5 w-5" /> : null}
                      {isAlert && !isUp ? <TrendingDown className="h-5 w-5" /> : null}
                      {!isAlert ? <Bell className="h-5 w-5" /> : null}
                    </div>

                    <div className="flex-1 min-w-0">
                      <div className="flex items-start justify-between gap-4 mb-1">
                        <h3 className={cn("font-semibold text-base", notif.read ? "text-muted-foreground" : "text-foreground")}>
                          {notif.title}
                        </h3>
                        <span className="text-xs text-muted-foreground shrink-0 mt-1">
                          {new Date(notif.createdAt).toLocaleDateString()}
                        </span>
                      </div>
                      <p className={cn("text-sm", notif.read ? "text-muted-foreground" : "text-foreground/90")}>
                        {notif.message}
                      </p>
                    </div>

                    {!notif.read && (
                      <Button 
                        variant="ghost" 
                        size="icon" 
                        onClick={() => markAsRead(notif.id)}
                        className="shrink-0 h-8 w-8 text-muted-foreground hover:text-aura-purple hover:bg-aura-purple/10"
                      >
                        <Check className="h-4 w-4" />
                      </Button>
                    )}
                  </CardContent>
                </Card>
              </motion.div>
            );
          })}
        </AnimatePresence>
      </div>
    </div>
  );
}
