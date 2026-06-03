import { LandingNav } from "@/components/landing/landing-nav";
import { LandingFooter } from "@/components/landing/landing-footer";

export default function InfoLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="relative min-h-screen flex flex-col justify-between overflow-hidden bg-background">
      {/* Visual background glows matching Aura's premium theme */}
      <div className="absolute top-[-10%] left-[10%] h-[600px] w-[600px] rounded-full bg-primary/5 blur-[150px] pointer-events-none" />
      <div className="absolute bottom-[20%] right-[-5%] h-[500px] w-[500px] rounded-full bg-purple-500/5 blur-[130px] pointer-events-none" />
      
      <LandingNav />
      <main className="flex-grow pt-28 pb-20 px-4 sm:px-6 lg:px-8 max-w-4xl mx-auto w-full z-10">
        {children}
      </main>
      <LandingFooter />
    </div>
  );
}
