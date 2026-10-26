/**
 * Per-agent / per-run email reporting (nodemailer).
 *
 * Config:
 *   report.email.smtp: { host, port, user?, password?, secure? }
 *   report.email.from: "argus@edtech.internal"
 *   agents.<id>.report: { type: "email", on: "failure-only", to: [...] }
 *
 * Text is passed pre-redacted by the caller (Redactor). This module only
 * transports; it never inspects content.
 */
import nodemailer from "nodemailer";

export interface EmailSmtp {
  host: string;
  port: number;
  user?: string;
  password?: string;
  secure?: boolean;
}

export interface EmailReportOptions {
  smtp: EmailSmtp;
  from: string;
  to: string[];
  subject: string;
  /** Plain text body (already redacted). */
  text: string;
  /** Timeout for the SMTP transaction. */
  timeoutMs?: number;
}

export interface EmailResult {
  sent: boolean;
  /** SMTP message id on success; detail on failure. */
  detail: string;
}

/**
 * Send one report email. Failures return {sent:false, detail} rather than
 * throwing — reporting must never take down a run that already produced its
 * evidence (honest scope: the run result is what the email reports).
 */
export async function sendEmailReport(opts: EmailReportOptions): Promise<EmailResult> {
  const transporter = nodemailer.createTransport({
    host: opts.smtp.host,
    port: opts.smtp.port,
    secure: opts.smtp.secure ?? false,
    ...(opts.smtp.user
      ? { auth: { user: opts.smtp.user, pass: opts.smtp.password ?? "" } }
      : {}),
  });
  try {
    const info = await Promise.race([
      transporter.sendMail({
        from: opts.from,
        to: opts.to,
        subject: opts.subject,
        text: opts.text,
      }),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`SMTP transaction timed out after ${opts.timeoutMs ?? 30_000}ms`)),
          opts.timeoutMs ?? 30_000,
        ),
      ),
    ]);
    return { sent: true, detail: `messageId=${info.messageId}` };
  } catch (e) {
    return { sent: false, detail: (e as Error).message };
  } finally {
    // Short-lived run: release the connection pool on the way out.
    try {
      transporter.close();
    } catch {
      // best-effort
    }
  }
}
