import { Resend } from "resend";

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

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
      from: "Aura Beam <noreply@aurabeam.com>", // Update with your verified domain later
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
