import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { EmptyState, ErrorState, LoadingState } from './States';
import { BreakdownList } from '@/components/dashboard/BreakdownList';
import { StatTile } from '@/components/dashboard/StatTile';
import { UptimeBar } from '@/components/dashboard/UptimeBar';
import { ApiClientError } from '@/lib/api';

describe('LoadingState', () => {
  it('exposes a busy live region for assistive tech', () => {
    render(<LoadingState label="Loading top pages" />);

    const status = screen.getByRole('status');
    expect(status).toHaveAttribute('aria-busy', 'true');
    expect(status).toHaveAttribute('aria-live', 'polite');
    expect(screen.getByText('Loading top pages')).toBeInTheDocument();
  });

  it('hides the skeleton bars themselves from the accessibility tree', () => {
    const { container } = render(<LoadingState label="Loading" variant="chart" />);

    // A screen reader announcing 24 grey rectangles would be noise; the live
    // region above already says "loading" once.
    const skeletons = container.querySelectorAll('.skeleton');
    expect(skeletons.length).toBeGreaterThan(0);
    expect(container.querySelector('[aria-hidden="true"]')).toBeInTheDocument();
  });

  it('renders a chart-shaped placeholder for the chart variant', () => {
    const { container } = render(<LoadingState label="Loading" variant="chart" />);
    expect(container.querySelectorAll('.skeleton')).toHaveLength(24);
  });
});

describe('EmptyState', () => {
  it('renders a title, description and optional action', async () => {
    const onClick = vi.fn();
    render(
      <EmptyState
        title="No monitors yet"
        description="Add a URL to get started."
        action={<button onClick={onClick}>Add monitor</button>}
      />,
    );

    expect(screen.getByText('No monitors yet')).toBeInTheDocument();
    expect(screen.getByText('Add a URL to get started.')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Add monitor' }));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('is not announced as an error', () => {
    render(<EmptyState title="Nothing here" />);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('ErrorState', () => {
  it('is announced as an alert', () => {
    render(<ErrorState error={new ApiClientError(500, 'internal', 'Boom')} />);
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByText('Boom')).toBeInTheDocument();
  });

  it('offers a retry for a retryable failure', async () => {
    const onRetry = vi.fn();
    render(
      <ErrorState error={new ApiClientError(0, 'network', 'Offline')} onRetry={onRetry} />,
    );

    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it('does not offer a retry for a 404, which retrying cannot fix', () => {
    render(
      <ErrorState error={new ApiClientError(404, 'not_found', 'Gone')} onRetry={vi.fn()} />,
    );
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
  });
});

describe('StatTile', () => {
  it('renders the label and value', () => {
    render(<StatTile label="Pageviews" value="12,480" />);
    expect(screen.getByText('Pageviews')).toBeInTheDocument();
    expect(screen.getByText('12,480')).toBeInTheDocument();
  });

  it('explains what the change is measured against', () => {
    render(<StatTile label="Pageviews" value="100" changePct={12} />);
    expect(screen.getByText('+12%')).toBeInTheDocument();
    expect(screen.getByText('compared with the previous period')).toBeInTheDocument();
  });

  it('treats a rise as bad when higher is worse', () => {
    // Failed checks going up is not a win, and the colour has to agree.
    const { container: good } = render(<StatTile label="Views" value="1" changePct={10} />);
    const { container: bad } = render(
      <StatTile label="Failures" value="1" changePct={10} higherIsBetter={false} />,
    );

    const goodColor = good.querySelector('p:last-of-type')?.getAttribute('style');
    const badColor = bad.querySelector('p:last-of-type')?.getAttribute('style');
    expect(goodColor).not.toBe(badColor);
  });

  it('falls back to a hint when there is no comparison', () => {
    render(<StatTile label="Top country" value="—" hint="No country data" />);
    expect(screen.getByText('No country data')).toBeInTheDocument();
  });
});

describe('BreakdownList', () => {
  const items = [
    { label: '/', count: 500 },
    { label: '/pricing', count: 250 },
    { label: '/docs', count: 50 },
  ];

  it('renders items in order with an accessible list name', () => {
    render(<BreakdownList items={items} ariaLabel="Top pages" emptyTitle="Nothing" />);

    const list = screen.getByRole('list', { name: 'Top pages' });
    const rows = screen.getAllByRole('listitem');
    expect(list).toBeInTheDocument();
    expect(rows[0]).toHaveTextContent('/');
    expect(rows[2]).toHaveTextContent('/docs');
  });

  it('scales bars against the largest item, not the total', () => {
    // Against the total (800), /docs would be 6% — a sliver conveying nothing.
    // Against the max (500) it is 10%, and the ordering stays readable.
    const { container } = render(
      <BreakdownList items={items} ariaLabel="Top pages" emptyTitle="Nothing" />,
    );
    const bars = container.querySelectorAll('[aria-hidden="true"]');
    expect(bars[0]?.getAttribute('style')).toContain('width: 100%');
    expect(bars[1]?.getAttribute('style')).toContain('width: 50%');
  });

  it('renders the empty state for an empty list', () => {
    render(<BreakdownList items={[]} ariaLabel="Top pages" emptyTitle="No pageviews yet" />);
    expect(screen.getByText('No pageviews yet')).toBeInTheDocument();
    expect(screen.queryByRole('list')).not.toBeInTheDocument();
  });

  it('supports a custom label renderer', () => {
    render(
      <BreakdownList
        items={[{ label: 'US', count: 10 }]}
        ariaLabel="Countries"
        emptyTitle="None"
        renderLabel={(code) => <span>Country: {code}</span>}
      />,
    );
    expect(screen.getByText(/Country: US/)).toBeInTheDocument();
  });
});

describe('UptimeBar', () => {
  const days = [
    { date: '2024-06-01', uptimePct: 100, totalChecks: 288, failedChecks: 0 },
    { date: '2024-06-02', uptimePct: null, totalChecks: 0, failedChecks: 0 },
    { date: '2024-06-03', uptimePct: 50, totalChecks: 288, failedChecks: 144 },
  ];

  it('describes the whole strip to assistive tech', () => {
    render(<UptimeBar days={days} label="API" />);
    expect(screen.getByRole('img', { name: /API/ })).toBeInTheDocument();
  });

  it('paints a day with no checks as unknown, never as healthy', () => {
    const { container } = render(<UptimeBar days={days} label="API" />);
    const bars = container.querySelectorAll('[title]');

    expect(bars[1]?.getAttribute('title')).toContain('no data');
    // Grey, not green — a status page that paints missing data as up invites
    // trust it has not earned.
    expect(bars[1]?.getAttribute('style')).toContain('var(--border-strong)');
    expect(bars[0]?.getAttribute('style')).toContain('var(--positive)');
    expect(bars[2]?.getAttribute('style')).toContain('var(--negative)');
  });

  it('averages only the days that have data', () => {
    // (100 + 50) / 2 = 75, not (100 + 0 + 50) / 3 = 50.
    render(<UptimeBar days={days} label="API" />);
    expect(screen.getByText('75.00% uptime')).toBeInTheDocument();
  });

  it('says "no data" when nothing has been measured', () => {
    render(
      <UptimeBar
        days={[{ date: '2024-06-01', uptimePct: null, totalChecks: 0, failedChecks: 0 }]}
        label="API"
      />,
    );
    expect(screen.getByText('No data')).toBeInTheDocument();
  });
});
