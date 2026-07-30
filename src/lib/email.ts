import { Resend } from "resend";
import { CONTACT_RECIPIENT, CONTACT_SUBJECT_LABELS, type ContactMessage } from "@/lib/contact";

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

/** Escape text that a stranger typed before it goes into an HTML email body.
 *  The contact form is the one place in this app where unauthenticated,
 *  arbitrary input is interpolated into markup, so it is the one place that
 *  must not do it raw. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export async function sendVerificationEmail(email: string, token: string) {
  const verifyUrl = `${process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000"}/verify?token=${token}&email=${encodeURIComponent(email)}`;

  if (!resend) {
    console.log("\n=======================================================");
    console.log(`✉️ EMAIL VERIFICATION LINK (Development Mode)`);
    console.log(`To: ${email}`);
    console.log(`Link: ${verifyUrl}`);
    console.log("=======================================================\n");
    return { success: true };
  }

  try {
    const { data, error } = await resend.emails.send({
      from: "Aura Beam <onboarding@resend.dev>", // Resend's shared test domain — no DNS verification needed. Switch to a verified custom domain once you own one; see aura/src/lib/email.ts history.
      to: email,
      subject: "Verify your email address - Aura Beam",
      html: `
        <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
          <h2>Welcome to Aura Beam!</h2>
          <p>Thank you for registering. Please verify your email address to activate your account.</p>
          <div style="margin: 30px 0;">
            <a href="${verifyUrl}" style="background-color: #7c3aed; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold;">Verify Email</a>
          </div>
          <p style="color: #666; font-size: 14px;">If the button doesn't work, copy and paste this link into your browser:</p>
          <p style="color: #666; font-size: 14px; word-break: break-all;">${verifyUrl}</p>
        </div>
      `,
    });

    if (error) {
      console.error("Resend Error:", error);
      return { success: false, error };
    }

    return { success: true, data };
  } catch (error) {
    console.error("Failed to send verification email:", error);
    return { success: false, error };
  }
}

/**
 * Deliver a contact-form submission to the support inbox.
 *
 * Same contract as sendVerificationEmail above: no client without
 * RESEND_API_KEY, a console fallback in that case, and a {success, error}
 * return rather than a throw — the caller decides what the visitor is told.
 *
 * The one thing this must never do is report a send it did not make. The
 * dev-mode branch returning success is honest because it did what it claims (it
 * logged the message where a developer can read it); a swallowed Resend error
 * returning success would not be, and the route would then tell someone their
 * message was received when it evaporated.
 */
export async function sendContactMessage(msg: ContactMessage) {
  const subjectLabel = CONTACT_SUBJECT_LABELS[msg.subject];
  const subjectLine = `[Aura Contact · ${subjectLabel}] ${msg.name}`;

  if (!resend) {
    console.log("\n=======================================================");
    console.log(`✉️ CONTACT MESSAGE (Development Mode — not sent)`);
    console.log(`To: ${CONTACT_RECIPIENT}`);
    console.log(`From: ${msg.name} <${msg.email}>`);
    console.log(`Subject: ${subjectLabel}`);
    console.log("-------------------------------------------------------");
    console.log(msg.message);
    console.log("=======================================================\n");
    return { success: true };
  }

  try {
    const { data, error } = await resend.emails.send({
      // Resend's shared test domain — the sender must be a domain we control,
      // so the visitor's address cannot go here. It goes in replyTo instead,
      // which is what makes hitting Reply in the inbox reach them.
      from: "Aura Beam <onboarding@resend.dev>",
      to: CONTACT_RECIPIENT,
      replyTo: msg.email,
      subject: subjectLine,
      html: `
        <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="margin-bottom: 4px;">New contact message</h2>
          <p style="color: #666; font-size: 14px; margin-top: 0;">${escapeHtml(subjectLabel)}</p>
          <table style="font-size: 14px; margin: 20px 0; border-collapse: collapse;">
            <tr>
              <td style="color: #666; padding: 4px 16px 4px 0;">Name</td>
              <td style="padding: 4px 0;">${escapeHtml(msg.name)}</td>
            </tr>
            <tr>
              <td style="color: #666; padding: 4px 16px 4px 0;">Email</td>
              <td style="padding: 4px 0;"><a href="mailto:${escapeHtml(msg.email)}">${escapeHtml(msg.email)}</a></td>
            </tr>
          </table>
          <div style="border-left: 3px solid #d4af37; padding: 4px 0 4px 16px; white-space: pre-wrap; font-size: 14px; line-height: 1.6;">${escapeHtml(msg.message)}</div>
          <p style="color: #999; font-size: 12px; margin-top: 30px;">Reply directly to this email to respond to ${escapeHtml(msg.name)}.</p>
        </div>
      `,
    });

    if (error) {
      console.error("Resend Error (contact):", error);
      return { success: false, error };
    }

    return { success: true, data };
  } catch (error) {
    console.error("Failed to send contact message:", error);
    return { success: false, error };
  }
}
