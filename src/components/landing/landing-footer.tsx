import Link from "next/link";
import { AuraMark } from "@/components/landing/aura-mark";

const footerLinks = {
  Product: [
    { label: "Features", href: "#features" },
    // BETA: Aura subscription pricing hidden for private beta. Restore this link when pricing returns.
    // { label: "Pricing", href: "#pricing" },
    { label: "Scanner", href: "/scanner" },
    { label: "Collection", href: "/collection" },
  ],
  Company: [
    { label: "About", href: "/about" },
    { label: "Contact", href: "/contact" },
  ],
  Legal: [
    { label: "Privacy", href: "/privacy" },
    { label: "Terms", href: "/terms" },
    { label: "Cookies", href: "/cookies" },
  ],
};

export function LandingFooter() {
  return (
    <footer className="border-t border-border bg-card/50">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-16">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-8">
          {/* Brand */}
          <div className="col-span-2 md:col-span-1">
            <Link href="/" className="flex items-center gap-2 mb-4">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary">
                <AuraMark className="h-[18px] w-[18px] text-primary-foreground" />
              </div>
              <span className="font-serif text-xl">Aura</span>
            </Link>
            <p className="text-sm text-muted-foreground leading-relaxed max-w-xs">
              A precise instrument for identifying, valuing, and archiving trading cards.
            </p>
          </div>

          {/* Link columns */}
          {Object.entries(footerLinks).map(([title, links]) => (
            <div key={title}>
              <h4 className="text-sm font-semibold mb-4">{title}</h4>
              <ul className="space-y-2.5">
                {links.map((link) => (
                  <li key={link.label}>
                    <Link
                      href={link.href}
                      className="text-sm text-muted-foreground hover:text-foreground transition-colors"
                    >
                      {link.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="mt-12 pt-8 border-t border-border flex flex-col sm:flex-row items-center justify-between gap-4">
          <p className="text-xs text-muted-foreground">
            © {new Date().getFullYear()} Aura. All rights reserved.
          </p>
          <p className="text-xs text-muted-foreground">
            Made for trading card collectors
          </p>
        </div>
      </div>
    </footer>
  );
}
