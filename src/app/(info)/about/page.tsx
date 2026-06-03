import { Sparkles, Shield, Cpu, Zap, Heart } from "lucide-react";

export const metadata = {
  title: "About Us | Aura",
  description: "Learn about Aura, the ultimate AI-powered trading card platform for collectors worldwide.",
};

export default function AboutPage() {
  return (
    <div className="space-y-12">
      {/* Hero Header */}
      <div className="text-center space-y-4">
        <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-primary/10 border border-primary/20 text-xs font-semibold text-primary mb-2">
          <Sparkles className="h-3 w-3" /> About Aura
        </div>
        <h1 className="text-4xl sm:text-5xl font-extrabold tracking-tight bg-gradient-to-r from-white via-neutral-200 to-neutral-500 bg-clip-text text-transparent">
          Empowering Card Collectors
        </h1>
        <p className="text-lg text-muted-foreground max-w-2xl mx-auto leading-relaxed">
          Aura was built by card collectors, for card collectors. Our mission is to combine cutting-edge artificial intelligence with live market data to simplify how you identify, value, and manage your trading card collections.
        </p>
      </div>

      {/* Grid Features */}
      <div className="grid md:grid-cols-2 gap-6 mt-8">
        <div className="p-6 rounded-2xl border border-border bg-card/40 backdrop-blur-md space-y-4">
          <div className="h-10 w-10 rounded-lg bg-purple-500/10 flex items-center justify-center text-purple-400">
            <Cpu className="h-5 w-5" />
          </div>
          <h3 className="text-xl font-bold">AI-Powered Recognition</h3>
          <p className="text-sm text-muted-foreground leading-relaxed">
            Using state-of-the-art vision models, Aura scans your physical cards, detects the set, variant, language, and card number in seconds, taking the manual searching out of cataloging.
          </p>
        </div>

        <div className="p-6 rounded-2xl border border-border bg-card/40 backdrop-blur-md space-y-4">
          <div className="h-10 w-10 rounded-lg bg-blue-500/10 flex items-center justify-center text-blue-400">
            <Zap className="h-5 w-5" />
          </div>
          <h3 className="text-xl font-bold">Live Market Data</h3>
          <p className="text-sm text-muted-foreground leading-relaxed">
            By integrating directly with industry-leading TCG database APIs, we provide near-instant updates on card market values, historic price trends, and portfolio estimates.
          </p>
        </div>

        <div className="p-6 rounded-2xl border border-border bg-card/40 backdrop-blur-md space-y-4">
          <div className="h-10 w-10 rounded-lg bg-emerald-500/10 flex items-center justify-center text-emerald-400">
            <Shield className="h-5 w-5" />
          </div>
          <h3 className="text-xl font-bold">Secure Collections</h3>
          <p className="text-sm text-muted-foreground leading-relaxed">
            Your collection data is saved securely in the cloud, allowing you to access your cards from any desktop or mobile device. Manage wishlists, monitor values, and build your trading empire.
          </p>
        </div>

        <div className="p-6 rounded-2xl border border-border bg-card/40 backdrop-blur-md space-y-4">
          <div className="h-10 w-10 rounded-lg bg-pink-500/10 flex items-center justify-center text-pink-400">
            <Heart className="h-5 w-5" />
          </div>
          <h3 className="text-xl font-bold">Built for the Community</h3>
          <p className="text-sm text-muted-foreground leading-relaxed">
            Whether you collect Pokémon, Yu-Gi-Oh!, Magic: The Gathering, or all of them, Aura is built to support the hobbies we all love with modern design aesthetics and simple user interfaces.
          </p>
        </div>
      </div>

      {/* Vision Statement */}
      <div className="relative rounded-3xl border border-border/80 bg-gradient-to-br from-card/30 to-purple-500/5 p-8 md:p-10 text-center overflow-hidden">
        <div className="absolute inset-0 bg-grid-white/[0.02] bg-[size:30px_30px]" />
        <div className="relative z-10 space-y-4 max-w-xl mx-auto">
          <h2 className="text-2xl font-bold">Our Vision</h2>
          <p className="text-sm text-muted-foreground leading-relaxed">
            We believe that organizing a trading card collection should be as enjoyable as opening a fresh booster pack. Aura will continue to innovate with better image recognition, direct trading integrations, and advanced collection insights.
          </p>
        </div>
      </div>
    </div>
  );
}
