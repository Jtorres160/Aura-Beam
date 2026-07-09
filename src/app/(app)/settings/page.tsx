"use client";

import { motion } from "framer-motion";
import { Settings, User, Bell, Palette, Shield, CreditCard } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";

export default function SettingsPage() {
  return (
    <div className="p-4 sm:p-6 lg:p-8 space-y-6 max-w-3xl">
      <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}>
        <h1 className="text-2xl sm:text-3xl font-bold flex items-center gap-2">
          <Settings className="h-6 w-6 text-aura-purple" /> Settings
        </h1>
      </motion.div>

      {/* Profile */}
      <Card className="glass border-border/50">
        <CardHeader><CardTitle className="text-base flex items-center gap-2"><User className="h-4 w-4 text-aura-purple" />Profile</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center gap-4">
            <Avatar className="h-16 w-16"><AvatarFallback className="bg-aura-purple/20 text-aura-purple text-xl font-bold">AK</AvatarFallback></Avatar>
            <Button variant="outline" size="sm" className="rounded-xl">Change Avatar</Button>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-2"><label className="text-sm font-medium">Username</label><Input defaultValue="AshKetchum" className="rounded-xl" /></div>
            <div className="space-y-2"><label className="text-sm font-medium">Email</label><Input defaultValue="ash@aura.gg" className="rounded-xl" /></div>
          </div>
          <Button className="gradient-bg text-white border-0 rounded-xl">Save Changes</Button>
        </CardContent>
      </Card>

      {/* Notifications */}
      <Card className="glass border-border/50">
        <CardHeader><CardTitle className="text-base flex items-center gap-2"><Bell className="h-4 w-4 text-aura-purple" />Notifications</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          {["Price alerts", "New features", "Weekly report"].map((item) => (
            <div key={item} className="flex items-center justify-between py-2">
              <span className="text-sm">{item}</span>
              <div className="h-6 w-11 rounded-full bg-aura-purple/20 relative cursor-pointer">
                <div className="absolute right-0.5 top-0.5 h-5 w-5 rounded-full bg-aura-purple transition-transform" />
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      {/* BETA: Aura subscription/upgrade UI hidden for private beta. Restore this card (and the CreditCard import) when pricing returns. */}
      {/* <Card className="glass border-border/50">
        <CardHeader><CardTitle className="text-base flex items-center gap-2"><CreditCard className="h-4 w-4 text-aura-purple" />Subscription</CardTitle></CardHeader>
        <CardContent>
          <div className="flex items-center justify-between">
            <div>
              <p className="font-medium">Free Plan</p>
              <p className="text-sm text-muted-foreground">50 scans/day · Basic features</p>
            </div>
            <Button className="gradient-bg text-white border-0 rounded-xl">Upgrade to Pro</Button>
          </div>
        </CardContent>
      </Card> */}
    </div>
  );
}
