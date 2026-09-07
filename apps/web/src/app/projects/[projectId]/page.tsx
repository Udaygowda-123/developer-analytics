'use client';

import { use } from 'react';
import type { ProjectDTO } from '@pulse/shared';
import { AnalyticsView } from '@/components/dashboard/AnalyticsView';
import { Card } from '@/components/ui/Card';
import { ErrorState, LoadingState } from '@/components/ui/States';
import { useApi } from '@/lib/use-api';

export default function ProjectDashboardPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = use(params);
  const { data, state, error, refetch } = useApi<{ project: ProjectDTO }>(
    `/api/projects/${projectId}`,
  );

  if (state.status === 'loading') {
    return (
      <div className="space-y-5">
        <LoadingState label="Loading project" variant="tiles" rows={4} />
        <Card>
          <LoadingState label="Loading traffic chart" variant="chart" />
        </Card>
      </div>
    );
  }

  if (state.status === 'error') {
    return (
      <Card>
        <ErrorState
          error={error!}
          onRetry={refetch}
          title={error!.code === 'not_found' ? 'Project not found' : 'Could not load this project'}
        />
      </Card>
    );
  }

  return <AnalyticsView project={data!.project} />;
}
