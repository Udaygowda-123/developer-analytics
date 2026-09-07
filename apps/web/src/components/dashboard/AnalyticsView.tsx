'use client';

import { useMemo, useState } from 'react';
import type { AnalyticsResponse, DateRange, ProjectDTO } from '@pulse/shared';
import { Card, CardHeader } from '@/components/ui/Card';
import { EmptyState, ErrorState, LoadingState } from '@/components/ui/States';
import { BreakdownList } from './BreakdownList';
import { RangePicker } from './RangePicker';
import { StatTile } from './StatTile';
import { TrafficChart } from './TrafficChart';
import { useApi } from '@/lib/use-api';
import { countryFlag, countryName, detectTimezone, formatCount, formatExact } from '@/lib/format';

/**
 * The analytics dashboard.
 *
 * Every widget below is fed by ONE request, because the server computes them
 * all in a single `$facet` aggregation. Firing a request per widget would be
 * the obvious client-side shape and would undo that entirely.
 */
export function AnalyticsView({ project }: { project: ProjectDTO }) {
  const [range, setRange] = useState<DateRange>('7d');
  // Resolved once: recomputing per render is wasted work, and the value cannot
  // change without a page reload anyway.
  const timezone = useMemo(detectTimezone, []);

  const { data, state, error, refetch } = useApi<AnalyticsResponse>(
    `/api/projects/${project.id}/analytics`,
    { query: { range, timezone } },
  );

  const hasData = data ? data.summary.pageviews > 0 : false;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold" style={{ color: 'var(--ink)' }}>
            {project.name}
          </h1>
          <p className="text-xs" style={{ color: 'var(--ink-subtle)' }}>
            {project.domain}
            {data ? (
              <>
                {' · '}
                <span title="Ranges over 30 days are served from nightly rollups.">
                  {data.source === 'rollups' ? 'from daily rollups' : 'from raw events'}
                </span>
              </>
            ) : null}
          </p>
        </div>
        <RangePicker value={range} onChange={setRange} disabled={state.status === 'loading'} />
      </div>

      {state.status === 'error' ? (
        <Card>
          <ErrorState error={error!} onRetry={refetch} title="Could not load analytics" />
        </Card>
      ) : (
        <>
          {/* Summary tiles */}
          {state.status === 'loading' ? (
            <LoadingState label="Loading summary" variant="tiles" rows={4} />
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <StatTile
                label="Pageviews"
                value={formatExact(data!.summary.pageviews)}
                changePct={data!.summary.pageviewsChangePct}
              />
              <StatTile
                label="Unique visitors"
                value={formatExact(data!.summary.uniqueVisitors)}
                changePct={data!.summary.uniqueVisitorsChangePct}
              />
              <StatTile
                label="Views per visitor"
                value={
                  data!.summary.uniqueVisitors > 0
                    ? (data!.summary.pageviews / data!.summary.uniqueVisitors).toFixed(2)
                    : '—'
                }
                hint="Pageviews divided by visitors"
              />
              <StatTile
                label="Top country"
                value={data!.countries[0] ? countryName(data!.countries[0].label) : '—'}
                hint={
                  data!.countries[0]
                    ? `${formatCount(data!.countries[0].count)} pageviews`
                    : 'No country data'
                }
              />
            </div>
          )}

          {/* Traffic over time */}
          <Card as="section">
            <CardHeader
              id="traffic-heading"
              title="Traffic over time"
              description={`Bucketed in ${timezone}`}
            />
            {state.status === 'loading' ? (
              <LoadingState label="Loading traffic chart" variant="chart" />
            ) : hasData ? (
              <TrafficChart series={data!.series} range={range} timezone={timezone} />
            ) : (
              <EmptyState
                title="No traffic yet"
                description="Once your snippet is installed, pageviews appear here within a couple of seconds."
              />
            )}
          </Card>

          {/* Breakdowns */}
          <div className="grid gap-4 lg:grid-cols-2">
            <Card as="section">
              <CardHeader title="Top pages" />
              {state.status === 'loading' ? (
                <LoadingState label="Loading top pages" />
              ) : (
                <BreakdownList
                  ariaLabel="Top pages"
                  items={data!.topPaths}
                  emptyTitle="No pageviews in this range"
                />
              )}
            </Card>

            <Card as="section">
              <CardHeader title="Top referrers" />
              {state.status === 'loading' ? (
                <LoadingState label="Loading referrers" />
              ) : (
                <BreakdownList
                  ariaLabel="Top referrers"
                  items={data!.topReferrers}
                  emptyTitle="No referrers yet"
                  emptyDescription="All traffic in this range arrived directly."
                />
              )}
            </Card>

            <Card as="section">
              <CardHeader title="Countries" />
              {state.status === 'loading' ? (
                <LoadingState label="Loading countries" />
              ) : (
                <BreakdownList
                  ariaLabel="Countries"
                  items={data!.countries}
                  emptyTitle="No country data"
                  emptyDescription="Country is read from a CDN header, which local traffic will not have."
                  renderLabel={(code) => (
                    <>
                      <span aria-hidden="true">{countryFlag(code)}</span> {countryName(code)}
                    </>
                  )}
                />
              )}
            </Card>

            <Card as="section">
              <CardHeader title="Devices and browsers" />
              {state.status === 'loading' ? (
                <LoadingState label="Loading device breakdown" />
              ) : (
                <div className="grid gap-4 sm:grid-cols-2">
                  <BreakdownList
                    ariaLabel="Devices"
                    items={data!.devices}
                    emptyTitle="No device data"
                    renderLabel={(label) => label.charAt(0).toUpperCase() + label.slice(1)}
                  />
                  <BreakdownList
                    ariaLabel="Browsers"
                    items={data!.browsers}
                    emptyTitle="No browser data"
                  />
                </div>
              )}
            </Card>
          </div>
        </>
      )}
    </div>
  );
}
