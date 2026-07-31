"use client";

import { useState } from "react";
import { AlertCircle, Mail, MessageSquare, Send, Sparkles, CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  CONTACT_MESSAGE_MAX,
  CONTACT_RECIPIENT,
  parseContactMessage,
  type ContactMessage,
} from "@/lib/contact";

export default function ContactPage() {
  const [formData, setFormData] = useState({
    name: "",
    email: "",
    subject: "general",
    message: "",
  });
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isSubmitted, setIsSubmitted] = useState(false);
  // The failure half, which did not exist before: this form could only ever
  // succeed. `field` names the input at fault for a validation rejection so the
  // visitor is not left hunting for what we objected to.
  const [error, setError] = useState<{ field?: keyof ContactMessage; message: string } | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    // Same parser the route runs. Catching a bad address here saves a round
    // trip; it does not replace the server's check, which is the real gate.
    const parsed = parseContactMessage(formData);
    if (!parsed.ok) {
      setError({ field: parsed.field, message: parsed.message });
      return;
    }

    setIsSubmitting(true);
    try {
      const res = await fetch("/api/contact", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(parsed.value),
      });
      const json = await res.json().catch(() => null);

      // Both halves must agree before we claim delivery. `res.ok` alone is not
      // enough — a proxy or a redirect can return a 200 that never reached the
      // route, and this form's entire bug was announcing a send that never
      // happened.
      if (!res.ok || !json?.success) {
        setError({
          field: json?.field,
          message: json?.message || "We couldn't send your message — it wasn't received.",
        });
        return;
      }

      // Cleared ONLY after a confirmed send. On any failure the typed message
      // stays exactly where it is: someone who just wrote three paragraphs must
      // not have them erased by our outage.
      setIsSubmitted(true);
      setFormData({ name: "", email: "", subject: "general", message: "" });
    } catch {
      // Network failure. The request may never have left the browser; either
      // way we did not see it land, so we do not say it did.
      setError({
        message: "Your message didn't send — check your connection and try again.",
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  /** Red ring on the input the server (or the parser) objected to. */
  const fieldClass = (field: keyof ContactMessage) =>
    error?.field === field
      ? "border-destructive focus:ring-destructive/50"
      : "border-border focus:ring-primary/50";

  return (
    <div className="space-y-12 max-w-4xl mx-auto">
      {/* Header */}
      <div className="text-center space-y-4">
        <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-primary/10 border border-primary/20 text-xs font-semibold text-primary mb-2">
          <MessageSquare className="h-3 w-3" /> Get in Touch
        </div>
        <h1 className="text-4xl font-extrabold tracking-tight bg-gradient-to-r from-white via-neutral-200 to-neutral-500 bg-clip-text text-transparent">
          We&apos;d love to hear from you
        </h1>
        <p className="text-lg text-muted-foreground max-w-xl mx-auto leading-relaxed">
          Have questions about scanning, feature requests, or business inquiries? Drop us a message below and we will get back to you as soon as possible.
        </p>
      </div>

      <div className="grid md:grid-cols-5 gap-8 items-start">
        {/* Contact Info (Left) */}
        <div className="md:col-span-2 space-y-6">
          <div className="p-6 rounded-2xl border border-border bg-card/40 backdrop-blur-md space-y-4">
            <h3 className="text-lg font-bold text-foreground">Contact Details</h3>
            <p className="text-sm text-muted-foreground leading-relaxed">
              If you prefer direct email communication, feel free to reach out to our team at any time.
            </p>

            <div className="space-y-4 pt-2">
              {/* Link and label both come from CONTACT_RECIPIENT — the same
                  constant the API route delivers to. Previously the mailto:
                  pointed at support@aurabeam.com while the text beside it read
                  a different address, so one of the two was always wrong. */}
              <a
                href={`mailto:${CONTACT_RECIPIENT}`}
                className="flex items-center gap-3 text-sm text-muted-foreground hover:text-primary transition-colors group"
              >
                <div className="h-9 w-9 rounded-lg bg-primary/10 flex items-center justify-center text-primary group-hover:bg-primary/20 transition-colors">
                  <Mail className="h-4.5 w-4.5" />
                </div>
                <div>
                  <p className="text-xs font-medium text-foreground">Email Support</p>
                  <p className="text-xs">{CONTACT_RECIPIENT}</p>
                </div>
              </a>
            </div>
          </div>

          <div className="p-6 rounded-2xl border border-border/80 bg-gradient-to-br from-card/30 to-purple-500/5 space-y-3">
            <h4 className="text-sm font-semibold flex items-center gap-1.5 text-foreground">
              <Sparkles className="h-4 w-4 text-purple-400" /> Looking for FAQs?
            </h4>
            <p className="text-xs text-muted-foreground leading-relaxed">
              Before submitting a ticket, check out our home page FAQs. Most questions about card databases and scanner limits are answered right there!
            </p>
          </div>
        </div>

        {/* Contact Form (Right) */}
        <div className="md:col-span-3">
          <div className="p-6 sm:p-8 rounded-2xl border border-border bg-card/40 backdrop-blur-md shadow-xl">
            {isSubmitted ? (
              <div className="text-center py-8 space-y-4 animate-in fade-in duration-500">
                <div className="h-12 w-12 rounded-full bg-emerald-500/10 text-emerald-400 flex items-center justify-center mx-auto">
                  <CheckCircle2 className="h-6 w-6" />
                </div>
                <div className="space-y-2">
                  <h3 className="text-xl font-bold text-foreground">Message Sent!</h3>
                  <p className="text-sm text-muted-foreground max-w-sm mx-auto">
                    Thank you for reaching out. A support team member will review your message and respond within 24–48 hours.
                  </p>
                </div>
                <Button
                  onClick={() => setIsSubmitted(false)}
                  variant="outline"
                  size="sm"
                  className="mt-2 text-xs"
                >
                  Send another message
                </Button>
              </div>
            ) : (
              <form onSubmit={handleSubmit} className="space-y-4">
                <div className="grid sm:grid-cols-2 gap-4">
                  <div className="space-y-1.5">
                    <label className="text-xs font-semibold text-muted-foreground" htmlFor="name">
                      Name
                    </label>
                    <input
                      id="name"
                      type="text"
                      required
                      placeholder="Your Name"
                      value={formData.name}
                      disabled={isSubmitting}
                      aria-invalid={error?.field === "name"}
                      onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                      className={`w-full bg-background/50 border rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 transition-all placeholder:text-muted-foreground/50 disabled:opacity-50 ${fieldClass("name")}`}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-xs font-semibold text-muted-foreground" htmlFor="email">
                      Email
                    </label>
                    <input
                      id="email"
                      type="email"
                      required
                      placeholder="you@example.com"
                      value={formData.email}
                      disabled={isSubmitting}
                      aria-invalid={error?.field === "email"}
                      onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                      className={`w-full bg-background/50 border rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 transition-all placeholder:text-muted-foreground/50 disabled:opacity-50 ${fieldClass("email")}`}
                    />
                  </div>
                </div>

                <div className="space-y-1.5">
                  <label className="text-xs font-semibold text-muted-foreground" htmlFor="subject">
                    Subject
                  </label>
                  <select
                    id="subject"
                    value={formData.subject}
                    disabled={isSubmitting}
                    onChange={(e) => setFormData({ ...formData, subject: e.target.value })}
                    className={`w-full bg-background/50 border rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 transition-all appearance-none disabled:opacity-50 ${fieldClass("subject")}`}
                  >
                    <option value="general" className="bg-card">General Inquiry</option>
                    <option value="support" className="bg-card">Technical Support</option>
                    {/* BETA: Billing & Payments option hidden for private beta. Restore this option when pricing returns. Support handling logic is unchanged. */}
                    {/* <option value="billing" className="bg-card">Billing & Payments</option> */}
                    <option value="feedback" className="bg-card">Feature Suggestion</option>
                  </select>
                </div>

                <div className="space-y-1.5">
                  <label className="text-xs font-semibold text-muted-foreground" htmlFor="message">
                    Message
                  </label>
                  <textarea
                    id="message"
                    required
                    rows={4}
                    maxLength={CONTACT_MESSAGE_MAX}
                    placeholder="Tell us what we can help with..."
                    value={formData.message}
                    disabled={isSubmitting}
                    aria-invalid={error?.field === "message"}
                    onChange={(e) => setFormData({ ...formData, message: e.target.value })}
                    className={`w-full bg-background/50 border rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 transition-all placeholder:text-muted-foreground/50 resize-none disabled:opacity-50 ${fieldClass("message")}`}
                  />
                </div>

                {/* A failed send is stated plainly and the form keeps every
                    word that was typed. The one thing this must never do is
                    clear itself and look like it worked — which is precisely
                    what the old setTimeout handler did on every submission. */}
                {error && (
                  <div
                    role="alert"
                    className="flex items-start gap-2.5 rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-3"
                  >
                    <AlertCircle className="h-4 w-4 shrink-0 text-destructive mt-0.5" />
                    <div className="space-y-1">
                      <p className="text-xs text-destructive leading-relaxed">{error.message}</p>
                      {/* Only offered when the send itself failed, not when the
                          visitor simply mistyped something they can fix here. */}
                      {!error.field && (
                        <a
                          href={`mailto:${CONTACT_RECIPIENT}`}
                          className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground transition-colors"
                        >
                          Email {CONTACT_RECIPIENT} directly
                        </a>
                      )}
                    </div>
                  </div>
                )}

                <Button
                  type="submit"
                  disabled={isSubmitting}
                  className="w-full gradient-bg text-white border-0 font-semibold flex items-center justify-center gap-2 py-5 rounded-xl text-sm mt-2 transition-opacity disabled:opacity-50"
                >
                  {isSubmitting ? (
                    <>Sending...</>
                  ) : error && !error.field ? (
                    <>
                      Try Sending Again <Send className="h-3.5 w-3.5" />
                    </>
                  ) : (
                    <>
                      Send Message <Send className="h-3.5 w-3.5" />
                    </>
                  )}
                </Button>
              </form>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
