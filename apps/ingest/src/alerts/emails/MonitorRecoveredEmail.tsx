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

export interface MonitorRecoveredEmailProps {
  monitorName: string;
  url: string;
  downtimeLabel: string;
  statusCode: number | null;
  latencyMs: number;
  dashboardUrl: string;
}

const styles = {
  body: { backgroundColor: '#f6f7f9', fontFamily: 'ui-sans-serif, system-ui, -apple-system, sans-serif' },
  container: { maxWidth: '520px', margin: '0 auto', padding: '32px 24px' },
  card: { backgroundColor: '#ffffff', borderRadius: '12px', padding: '32px', border: '1px solid #e5e7eb' },
  badge: {
    display: 'inline-block',
    backgroundColor: '#dcfce7',
    color: '#166534',
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

export function MonitorRecoveredEmail({
  monitorName,
  url,
  downtimeLabel,
  statusCode,
  latencyMs,
  dashboardUrl,
}: MonitorRecoveredEmailProps) {
  return (
    <Html lang="en">
      <Head />
      <Preview>{`${monitorName} is back up after ${downtimeLabel}`}</Preview>
      <Body style={styles.body}>
        <Container style={styles.container}>
          <Section style={styles.card}>
            <Text style={styles.badge}>Resolved</Text>
            <Heading style={styles.heading}>{monitorName} has recovered</Heading>
            <Text style={styles.text}>
              {`It responded normally after approximately ${downtimeLabel} of downtime.`}
            </Text>
            <Text style={styles.mono}>{url}</Text>
            <Text style={styles.text}>
              <strong>Latest check:</strong>{' '}
              {statusCode === null ? 'OK' : `HTTP ${statusCode}`} in {latencyMs} ms
            </Text>
            <Hr style={styles.hr} />
            <Button style={styles.button} href={dashboardUrl}>
              View monitor
            </Button>
            <Text style={styles.footer}>Sent by Pulse.</Text>
          </Section>
        </Container>
      </Body>
    </Html>
  );
}

export default MonitorRecoveredEmail;
