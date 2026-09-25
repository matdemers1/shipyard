import { request, RefusalError } from './api';
import type { CommitsResponse } from './dryrun';

/**
 * The dry-run sheet's changelog lookup (SHP-T-5.8, SHP-REQ-087): commits between live and an
 * exact candidate SHA — the console already knows the candidate before it asks, so it asks for
 * exactly what would ship rather than whatever the default branch happens to be at the moment the
 * response comes back. `null` when the endpoint is unavailable, same as the unscoped lookup.
 */
export async function getCommitsTo(app: string, to: string): Promise<CommitsResponse | null> {
  try {
    return await request<CommitsResponse>(`/api/apps/${app}/commits?to=${encodeURIComponent(to)}`);
  } catch (error) {
    if (error instanceof RefusalError && (error.status === 404 || error.status === 501 || error.status === 400)) return null;
    throw error;
  }
}
