import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';

/**
 * Live percent of a server-side slice job. A job that is gone (swept after
 * 30 min, lost on restart) or owned by someone else (403/404) yields an
 * indeterminate `percent: null` instead of an error.
 */
export function useSliceJobPercent(jobId: number | null | undefined): { percent: number | null; failed: boolean } {
  const { data } = useQuery({
    queryKey: ['slice-job', jobId],
    queryFn: () => api.getSliceJob(jobId as number),
    enabled: jobId != null,
    retry: false,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === 'pending' || status === 'running' ? 1500 : false;
    },
  });
  if (!data) return { percent: null, failed: false };
  return {
    percent: data.progress ? Math.round(data.progress.total_percent) : null,
    failed: data.status === 'failed',
  };
}
