import { Calendar } from "lucide-react";

export const metadata = {
  title: "Cookie Policy | Aura",
  description: "Read the Aura Cookie Policy. Understand how we use cookies, NextAuth tokens, and local storage to enhance your browsing experience.",
};

export default function CookiesPage() {
  return (
    <div className="space-y-8 max-w-3xl mx-auto">
      {/* Page Title */}
      <div className="space-y-3 border-b border-border pb-6">
        <h1 className="text-3xl font-extrabold tracking-tight">Cookie Policy</h1>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Calendar className="h-3.5 w-3.5" />
          <span>Last Updated: June 3, 2026</span>
        </div>
      </div>

      <p className="text-sm text-muted-foreground leading-relaxed">
        This Cookie Policy explains how Aura ("we", "us", or "our") uses cookies and similar tracking technologies when you use our website at <a href="https://aura-beam.vercel.app" className="text-primary hover:underline">https://aura-beam.vercel.app</a> (the "Service").
      </p>

      {/* Policy Content */}
      <div className="space-y-8 text-sm text-muted-foreground leading-relaxed">
        <section className="space-y-3">
          <h2 className="text-lg font-bold text-foreground">1. What are Cookies and Tracking Technologies?</h2>
          <p>
            Cookies are small data files stored on your computer or mobile device when you visit a website. They are widely used by website owners to make their websites work, or to work more efficiently, as well as to provide reporting information.
          </p>
          <p>
            In addition to cookies, we may use other local storage technologies, such as browser LocalStorage, to cache image previews, save camera choices, and store dark mode configurations.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-lg font-bold text-foreground">2. Why Do We Use Cookies?</h2>
          <p>
            We use first-party and third-party cookies for several reasons. Some cookies are required for technical reasons in order for our Service to operate, and we refer to these as "essential" or "strictly necessary" cookies. Other cookies enable us to track and target the interests of our users to enhance the experience on our Service.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-lg font-bold text-foreground">3. Types of Cookies and Caching We Use</h2>
          <div className="space-y-6">
            <div className="space-y-2">
              <h3 className="text-sm font-semibold text-foreground">A. Strictly Necessary (Essential) Cookies</h3>
              <p>These cookies are critical to authenticate users and prevent fraudulent use of user accounts. For example, our NextAuth framework utilizes secure cookies to hold your encrypted session key once you sign in:</p>
              <ul className="list-disc pl-5 space-y-1 text-xs">
                <li><code>next-auth.session-token</code> (stores active session data for logins)</li>
                <li><code>next-auth.csrf-token</code> (protects your account from Cross-Site Request Forgery attacks)</li>
                <li><code>next-auth.callback-url</code> (remembers where to redirect you after a successful OAuth login)</li>
              </ul>
            </div>

            <div className="space-y-2">
              <h3 className="text-sm font-semibold text-foreground">B. Functionality and Preference Settings</h3>
              <p>We use browser local storage (similar to cookies) to retain your interface preferences between sessions. This includes:</p>
              <ul className="list-disc pl-5 space-y-1 text-xs">
                <li>Theme preferences (saving your dark theme preference so the screen doesn't flicker light mode when loading)</li>
                <li>Camera device ID configuration (saving which phone/webcam camera you selected for card scanning)</li>
              </ul>
            </div>

            <div className="space-y-2">
              <h3 className="text-sm font-semibold text-foreground">C. Performance & Analytics Cookies</h3>
              <p>We may use third-party analytics (such as Vercel Web Analytics) which place light diagnostic identifiers on your device to log page speeds, error rates, and load times. This helps us ensure the card scanner builds and API responses are functioning correctly across different devices.</p>
            </div>
          </div>
        </section>

        <section className="space-y-3">
          <h2 className="text-lg font-bold text-foreground">4. How Can I Control Cookies?</h2>
          <p>
            You have the right to decide whether to accept or reject cookies. You can set or amend your web browser controls to accept or refuse cookies. If you choose to reject essential cookies, you may still use our website, though your access to secure dashboard binders, collections, and account profiles will be disabled because we cannot keep you logged in without cookies.
          </p>
          <p>
            To manage your cookies, check your browser's help menu (typically under "Privacy & Security" or "Clear Browsing Data").
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-lg font-bold text-foreground">5. Updates to This Cookie Policy</h2>
          <p>
            We may update this Cookie Policy from time to time in order to reflect, for example, changes to the cookies we use or for other operational, legal, or regulatory reasons. Please re-visit this Cookie Policy regularly to stay informed about our use of cookies and related technologies.
          </p>
        </section>
      </div>
    </div>
  );
}
