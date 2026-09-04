import {
  Body,
  Button,
  Container,
  Head,
  Heading,
  Hr,
  Html,
  Preview,
  Section,
  Text,
} from '@react-email/components';

export interface MonitorDownEmailProps {
  monitorName: string;
  url: string;
  error: string;
  consecutiveFailures: number;
  failingSince: string;
  dashboardUrl: string;
}

const styles = {
  body: { backgroundColor: '#f6f7f9', fontFamily: 'ui-sans-serif, system-ui, -apple-system, sans-serif' },
  container: { maxWidth: '520px', margin: '0 auto', padding: '32px 24px' },
  card: { backgroundColor: '#ffffff', borderRadius: '12px', padding: '32px', border: '1px solid #e5e7eb' },
  badge: {
    display: 'inline-block',
    backgroundColor: '#fee2e2',
    color: '#991b1b',
    fontSize: '12px',
    fontWeight: 600,
    letterSpacing: '0.05em',
    textTransform: 'uppercase' as const,
    padding: '4px 10px',
    borderRadius: '999px',
    margin: '0 0 16px',
  },
  heading: { fontSize: '22px', fontWeight: 700, color: '#111827', margin: '0 0 8px' },
  text: { fontSize: '14px', lineHeight: '22px', color: '#374151', margin: '0 0 12px' },
  mono: {
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    fontSize: '13px',
    backgroundColor: '#f3f4f6',
    padding: '10px 12px',
    borderRadius: '6px',
    color: '#111827',
    wordBreak: 'break-all' as const,
    margin: '0 0 12px',
  },
  button: {
    backgroundColor: '#111827',
    color: '#ffffff',
    fontSize: '14px',
    fontWeight: 600,
    padding: '11px 20px',
    borderRadius: '8px',
    textDecoration: 'none',
    display: 'inline-block',
  },
  footer: { fontSize: '12px', color: '#6b7280', margin: '16px 0 0' },
  hr: { borderColor: '#e5e7eb', margin: '24px 0' },
};

export function MonitorDownEmail({
  monitorName,
  url,
  error,
  consecutiveFailures,
  failingSince,
  dashboardUrl,
}: MonitorDownEmailProps) {
  return (
    <Html lang="en">
      <Head />
      {/* Preview text is what shows in the inbox list — put the actionable
          fact there, not a greeting. */}
      <Preview>{`${monitorName} is down — ${error}`}</Preview>
      <Body style={styles.body}>
        <Container style={styles.container}>
          <Section style={styles.card}>
            <Text style={styles.badge}>Incident</Text>
            <Heading style={styles.heading}>{monitorName} is down</Heading>
            <Text style={styles.text}>
              {`Pulse has recorded ${consecutiveFailures} consecutive failed checks since ${failingSince}.`}
            </Text>
            <Text style={styles.mono}>{url}</Text>
            <Text style={styles.text}>
              <strong>Last error:</strong> {error}
            </Text>
            <Hr style={styles.hr} />
            <Button style={styles.button} href={dashboardUrl}>
              View monitor
            </Button>
            <Text style={styles.footer}>
              You will not receive another alert for this monitor for at least an hour. A recovery
              email will be sent as soon as it comes back.
            </Text>
          </Section>
        </Container>
      </Body>
    </Html>
  );
}

export default MonitorDownEmail;
