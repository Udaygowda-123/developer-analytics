import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnalyticsResponse, ProjectDTO } from '@pulse/shared';
import { AnalyticsView } from './AnalyticsView';
import { ApiClientError } from '@/lib/api';

/**
 * The dashboard's four states — loading, empty, error, populated — plus the
 * range picker's keyboard behaviour.
 *
 * `useApi` is mocked rather than `fetch`: these are tests of what the
 * component renders for a given state, and going through the real hook would
 * make them tests of the hook's timing instead.
 */

const mockUseApi = vi.fn();
vi.mock('@/lib/use-api', () => ({
  useApi: (...args: unknown[]) => mockUseApi(...args),
  useApiMutation: () => ({ mutate: vi.fn(), isPending: false, error: null, reset: vi.fn() }),
}));

vi.mock('@/lib/auth-context', () => ({
  useAuth: () => ({
    user: { email: 'demo@example.com' },
    loading: false,
    configured: true,
    getToken: async () => 'token',
    signIn: vi.fn(),
    signUp: vi.fn(),
    signInWithGoogle: vi.fn(),
    signOut: vi.fn(),
  }),
}));

const PROJECT: ProjectDTO = {
  id: '65f0000000000000000000aa',
  ownerId: '65f0000000000000000000bb',
  name: 'Acme Marketing Site',
  slug: 'acme-marketing-site-abc123',
  domain: 'acme.example',
  apiKey: 'pk_live_ABCDefgh23456789ABCDefgh23456789',
  createdAt: '2024-01-01T00:00:00.000Z',
};

function analytics(overrides: Partial<AnalyticsResponse> = {}): AnalyticsResponse {
  return {
    range: '7d',
    timezone: 'UTC',
    source: 'events',
    from: '2024-06-09T00:00:00.000Z',
    to: '2024-06-16T00:00:00.000Z',
    summary: {
      pageviews: 12_480,
      uniqueVisitors: 4_210,
      pageviewsChangePct: 23.4,
      uniqueVisitorsChangePct: -5.1,
    },
    series: Array.from({ length: 7 }, (_, i) => ({
      bucket: `2024-06-${String(9 + i).padStart(2, '0')}T00:00:00.000Z`,
      pageviews: 1500 + i * 120,
      uniqueVisitors: 500 + i * 40,
    })),
    topPaths: [
      { label: '/', count: 5200 },
      { label: '/pricing', count: 2100 },
    ],
    topReferrers: [{ label: 'news.ycombinator.com', count: 1800 }],
    countries: [
      { label: 'US', count: 4000 },
      { label: 'GB', count: 1200 },
    ],
    devices: [
      { label: 'desktop', count: 7000 },
      { label: 'mobile', count: 5000 },
    ],
    browsers: [{ label: 'Chrome', count: 9000 }],
    ...overrides,
  };
}

function mockState(state: {
  status: 'loading' | 'success' | 'error';
  data?: AnalyticsResponse;
  error?: ApiClientError;
}) {
  const refetch = vi.fn();
  mockUseApi.mockReturnValue({
    state: { status: state.status, data: state.data ?? null, error: state.error ?? null },
    data: state.data ?? null,
    error: state.error ?? null,
    isLoading: state.status === 'loading',
    refetch,
  });
  return refetch;
}

beforeEach(() => {
  mockUseApi.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('loading state', () => {
  it('announces that it is loading and shows skeletons', () => {
    mockState({ status: 'loading' });
    render(<AnalyticsView project={PROJECT} />);

    const statuses = screen.getAllByRole('status');
    expect(statuses.length).toBeGreaterThan(0);
    expect(statuses[0]).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByText('Loading traffic chart')).toBeInTheDocument();
  });

  it('does not render stale numbers while loading', () => {
    mockState({ status: 'loading' });
    render(<AnalyticsView project={PROJECT} />);

    expect(screen.queryByText('12.5k')).not.toBeInTheDocument();
  });

  it('disables the range picker while a request is in flight', () => {
    mockState({ status: 'loading' });
    render(<AnalyticsView project={PROJECT} />);

    expect(screen.getByRole('radio', { name: 'Last 7 days' })).toBeDisabled();
  });
});

describe('error state', () => {
  it('renders an alert with the server message and a retry button', async () => {
    const error = new ApiClientError(500, 'internal', 'Aggregation timed out');
    const refetch = mockState({ status: 'error', error });
    render(<AnalyticsView project={PROJECT} />);

    const alert = screen.getByRole('alert');
    expect(within(alert).getByText('Could not load analytics')).toBeInTheDocument();
    expect(within(alert).getByText('Aggregation timed out')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(refetch).toHaveBeenCalledOnce();
  });

  it('hides the retry button for an error a retry cannot fix', () => {
    mockState({
      status: 'error',
      error: new ApiClientError(403, 'forbidden', 'You do not have access to this resource'),
    });
    render(<AnalyticsView project={PROJECT} />);

    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
  });
});

describe('empty state', () => {
  it('explains what to do instead of showing an empty chart', () => {
    mockState({
      status: 'success',
      data: analytics({
        summary: { pageviews: 0, uniqueVisitors: 0, pageviewsChangePct: null, uniqueVisitorsChangePct: null },
        series: [],
        topPaths: [],
        topReferrers: [],
        countries: [],
        devices: [],
        browsers: [],
      }),
    });
    render(<AnalyticsView project={PROJECT} />);

    expect(screen.getByText('No traffic yet')).toBeInTheDocument();
    expect(screen.getByText(/Once your snippet is installed/)).toBeInTheDocument();
  });

  it('distinguishes "no referrers" from "no data at all"', () => {
    mockState({ status: 'success', data: analytics({ topReferrers: [] }) });
    render(<AnalyticsView project={PROJECT} />);

    expect(screen.getByText('No referrers yet')).toBeInTheDocument();
    expect(screen.getByText('All traffic in this range arrived directly.')).toBeInTheDocument();
  });
});

describe('populated state', () => {
  beforeEach(() => {
    mockState({ status: 'success', data: analytics() });
  });

  it('renders headline counts at full precision, not abbreviated', () => {
    render(<AnalyticsView project={PROJECT} />);

    // Locale-agnostic: assert against the same formatting the app uses, so
    // this does not fail on a CI runner with a different default locale.
    expect(screen.getByText((12_480).toLocaleString())).toBeInTheDocument();
    expect(screen.getByText((4_210).toLocaleString())).toBeInTheDocument();
    // Abbreviating a headline number while the chart shows the real shape is
    // how a dashboard contradicts itself.
    expect(screen.queryByText('12k')).not.toBeInTheDocument();
  });

  it('shows period-over-period change with direction', () => {
    render(<AnalyticsView project={PROJECT} />);

    expect(screen.getByText('+23.4%')).toBeInTheDocument();
    expect(screen.getByText('-5.1%')).toBeInTheDocument();
  });

  it('computes views per visitor', () => {
    render(<AnalyticsView project={PROJECT} />);
    // 12480 / 4210 = 2.9644...
    expect(screen.getByText('2.96')).toBeInTheDocument();
  });

  it('renders the chart as an accessible table alongside the SVG', () => {
    render(<AnalyticsView project={PROJECT} />);

    const table = screen.getByRole('table', {
      name: /Pageviews and unique visitors over the selected period/,
    });
    // One row per bucket, so the data is reachable without seeing the chart.
    expect(within(table).getAllByRole('row')).toHaveLength(8); // header + 7
  });

  it('lists top pages in rank order', () => {
    render(<AnalyticsView project={PROJECT} />);

    const list = screen.getByRole('list', { name: 'Top pages' });
    const items = within(list).getAllByRole('listitem');
    expect(items[0]).toHaveTextContent('/');
    expect(items[1]).toHaveTextContent('/pricing');
  });

  it('renders country names, not raw codes', () => {
    render(<AnalyticsView project={PROJECT} />);

    const list = screen.getByRole('list', { name: 'Countries' });
    expect(within(list).getByText(/United States/)).toBeInTheDocument();
  });

  it('tells the user which source the numbers came from', () => {
    render(<AnalyticsView project={PROJECT} />);
    expect(screen.getByText('from raw events')).toBeInTheDocument();
  });
});

describe('rollup source', () => {
  it('says so when reading from rollups', () => {
    mockState({ status: 'success', data: analytics({ range: '90d', source: 'rollups' }) });
    render(<AnalyticsView project={PROJECT} />);

    expect(screen.getByText('from daily rollups')).toBeInTheDocument();
  });
});

describe('range picker', () => {
  it('is a radiogroup with exactly one selected option', () => {
    mockState({ status: 'success', data: analytics() });
    render(<AnalyticsView project={PROJECT} />);

    const group = screen.getByRole('radiogroup', { name: 'Date range' });
    const radios = within(group).getAllByRole('radio');
    expect(radios).toHaveLength(4);
    expect(radios.filter((r) => r.getAttribute('aria-checked') === 'true')).toHaveLength(1);
  });

  it('keeps only the selected option in the tab order', () => {
    mockState({ status: 'success', data: analytics() });
    render(<AnalyticsView project={PROJECT} />);

    const radios = within(screen.getByRole('radiogroup')).getAllByRole('radio');
    expect(radios.filter((r) => r.getAttribute('tabindex') === '0')).toHaveLength(1);
  });

  it('changes range on click and refetches with the new range', async () => {
    mockState({ status: 'success', data: analytics() });
    render(<AnalyticsView project={PROJECT} />);

    await userEvent.click(screen.getByRole('radio', { name: 'Last 30 days' }));

    await waitFor(() => {
      const lastCall = mockUseApi.mock.calls.at(-1);
      expect(lastCall?.[1]).toMatchObject({ query: expect.objectContaining({ range: '30d' }) });
    });
  });

  it('moves selection with arrow keys', async () => {
    mockState({ status: 'success', data: analytics() });
    render(<AnalyticsView project={PROJECT} />);

    const selected = screen.getByRole('radio', { name: 'Last 7 days' });
    selected.focus();
    await userEvent.keyboard('{ArrowRight}');

    await waitFor(() => {
      expect(screen.getByRole('radio', { name: 'Last 30 days' })).toHaveAttribute(
        'aria-checked',
        'true',
      );
    });
  });
});
