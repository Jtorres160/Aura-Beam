import { HeroSection } from "@/components/landing/hero-section";
import { FeaturesSection } from "@/components/landing/features-section";
import { GamesSection } from "@/components/landing/games-section";
// BETA: Aura subscription pricing hidden for private beta. Restore this import to bring back the pricing section.
// import { PricingSection } from "@/components/landing/pricing-section";
import { FaqSection } from "@/components/landing/faq-section";
import { LandingNav } from "@/components/landing/landing-nav";
import { LandingFooter } from "@/components/landing/landing-footer";

export default function HomePage() {
  return (
    <main className="relative min-h-screen overflow-hidden">
      <LandingNav />
      <HeroSection />
      <FeaturesSection />
      <GamesSection />
      {/* BETA: Aura subscription pricing hidden for private beta. Restore <PricingSection /> to bring it back. */}
      {/* <PricingSection /> */}
      <FaqSection />
      <LandingFooter />
    </main>
  );
}
