import { render } from '@react-email/components';
import { Resend } from 'resend';
import type { ReactElement } from 'react';
import { getConfig } from '../config.js';
import { createLogger } from '../logger.js';

const log = createLogger('alerts:mailer');

export interface SendEmailInput {
  to: string;
  subject: string;
  /** React Email element, rendered to HTML *server-side* before sending. */
  body: ReactElement;
}

export interface Mailer {
  send(input: SendEmailInput): Promise<{ id: string | null; delivered: boolean }>;
}

let mailer: Mailer | null = null;

function buildMailer(): Mailer {
  const cfg = getConfig();

  if (!cfg.RESEND_API_KEY) {
    // Without a key, log the email instead of failing. Alerting is not
    // load-bearing for local development, and crashing the scheduler because
    // nobody configured Resend would be a poor trade.
    log.warn('RESEND_API_KEY is not set — alert emails will be logged, not sent');
    return {
      async send({ to, subject, body }) {
        const html = await render(body);
        log.info('email (not sent, no RESEND_API_KEY)', { to, subject, htmlBytes: html.length });
        return { id: null, delivered: false };
      },
    };
  }

  const resend = new Resend(cfg.RESEND_API_KEY);

  return {
    async send({ to, subject, body }) {
      // Both HTML and a plaintext fallback: some clients (and most alerting
      // pipelines that forward to Slack/SMS) only read text/plain.
      const [html, text] = await Promise.all([render(body), render(body, { plainText: true })]);

      const { data, error } = await resend.emails.send({
        from: cfg.ALERT_FROM_EMAIL,
        to,
        subject,
        html,
        text,
      });

      if (error) {
        // Surfaced to the caller, which decides whether to retry. We do not
        // retry here: the cooldown slot is already claimed, and a retry loop
        // inside the scheduler would block the sweep.
        throw new Error(`Resend rejected the message: ${error.message}`, { cause: error });
      }

      return { id: data?.id ?? null, delivered: true };
    },
  };
}

export function getMailer(): Mailer {
  mailer ??= buildMailer();
  return mailer;
}

export function setMailerForTesting(stub: Mailer | null): void {
  mailer = stub;
}
