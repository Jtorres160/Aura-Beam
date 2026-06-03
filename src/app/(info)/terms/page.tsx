import { Calendar } from "lucide-react";

export const metadata = {
  title: "Terms of Service | Aura",
  description: "Read the Aura Terms of Service. Review rules, guidelines, card valuation disclaimers, and legal agreements for our AI trading card platform.",
};

export default function TermsPage() {
  return (
    <div className="space-y-8 max-w-3xl mx-auto">
      {/* Page Title */}
      <div className="space-y-3 border-b border-border pb-6">
        <h1 className="text-3xl font-extrabold tracking-tight">Terms of Service</h1>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Calendar className="h-3.5 w-3.5" />
          <span>Last Updated: June 3, 2026</span>
        </div>
      </div>

      <p className="text-sm text-muted-foreground leading-relaxed">
        Please read these Terms of Service ("Terms", "Terms of Service") carefully before using the <a href="https://aura-beam.vercel.app" className="text-primary hover:underline">https://aura-beam.vercel.app</a> website (the "Service") operated by Aura ("us", "we", or "our").
      </p>

      {/* Policy Content */}
      <div className="space-y-8 text-sm text-muted-foreground leading-relaxed">
        <section className="space-y-3">
          <h2 className="text-lg font-bold text-foreground">1. Agreement to Terms</h2>
          <p>
            Your access to and use of the Service is conditioned on your acceptance of and compliance with these Terms. These Terms apply to all visitors, users, and others who access or use the Service.
          </p>
          <p>
            By accessing or using the Service you agree to be bound by these Terms. If you disagree with any part of the terms, then you may not access the Service.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-lg font-bold text-foreground">2. Accounts and Registrations</h2>
          <p>
            When you create an account with us, you must provide us with information that is accurate, complete, and current at all times. Failure to do so constitutes a breach of the Terms, which may result in immediate termination of your account on our Service.
          </p>
          <p>
            You are responsible for safeguarding the password that you use to access the Service and for any activities or actions under your password, whether your password is with our Service or a third-party service. You agree not to disclose your password to any third party. You must notify us immediately upon becoming aware of any breach of security or unauthorized use of your account.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-lg font-bold text-foreground">3. Card Valuation Disclaimer</h2>
          <p className="p-4 rounded-xl border border-destructive/20 bg-destructive/5 text-destructive-foreground">
            <strong>IMPORTANT:</strong> Aura provides AI-based card scanning identification and retrieves pricing metadata from external databases (such as TCGPlayer, Cardmarket, or other developer APIs). All card valuation estimates, historical graphs, and binder values are provided for informational and educational purposes only. They do not constitute financial advice, appraisal values, or guaranteed offers to buy or sell. We are not responsible for any financial losses or incorrect sales transactions resulting from database discrepancies.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-lg font-bold text-foreground">4. Intellectual Property & Fair Use</h2>
          <p>
            Aura is a utility application designed to help fans track their collection.
          </p>
          <ul className="list-disc pl-5 space-y-2">
            <li><strong>Aura Intellectual Property:</strong> The Service and its original content, features, and functionality (excluding user-submitted images or trademarked card assets) are and will remain the exclusive property of Aura and its licensors.</li>
            <li><strong>Card & Franchise Trademarks:</strong> Pokémon, Magic: The Gathering, Yu-Gi-Oh!, and related logos, character names, and card artwork are copyrighted trademarks of their respective owners (Nintendo, Creatures, Game Freak, Wizards of the Coast, Konami, etc.). Aura is completely unofficial and is not endorsed by or affiliated with these entities in any capacity.</li>
          </ul>
        </section>

        <section className="space-y-3">
          <h2 className="text-lg font-bold text-foreground">5. Prohibited Activities</h2>
          <p>You agree not to engage in any of the following prohibited behaviors:</p>
          <ul className="list-disc pl-5 space-y-2">
            <li>Using any scraper, robot, spider, or automated scripts to collect card information or prices from our website.</li>
            <li>Uploading false, manipulated, or non-card images to the scan API endpoint.</li>
            <li>Attempting to interfere with the proper working of the Service, overload API bandwidth, or bypass server security measures.</li>
            <li>Creating multiple dummy accounts to abuse free tier rate-limits or scanner allowances.</li>
          </ul>
        </section>

        <section className="space-y-3">
          <h2 className="text-lg font-bold text-foreground">6. Termination</h2>
          <p>
            We may terminate or suspend access to our Service immediately, without prior notice or liability, for any reason whatsoever, including without limitation if you breach the Terms.
          </p>
          <p>
            All provisions of the Terms which by their nature should survive termination shall survive termination, including, without limitation, ownership provisions, warranty disclaimers, indemnity, and limitations of liability.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-lg font-bold text-foreground">7. Limitation of Liability</h2>
          <p>
            In no event shall Aura, nor its directors, employees, partners, agents, suppliers, or affiliates, be liable for any indirect, incidental, special, consequential, or punitive damages, including without limitation, loss of profits, data, use, goodwill, or other intangible losses, resulting from (i) your access to or use of or inability to access or use the Service; (ii) any conduct or content of any third party on the Service; (iii) any content obtained from the Service; and (iv) unauthorized access, use, or alteration of your transmissions or content.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-lg font-bold text-foreground">8. Governing Law</h2>
          <p>
            Our failure to enforce any right or provision of these Terms will not be considered a waiver of those rights. If any provision of these Terms is held to be invalid or unenforceable by a court, the remaining provisions of these Terms will remain in effect. These Terms constitute the entire agreement between us regarding our Service.
          </p>
        </section>
      </div>
    </div>
  );
}
