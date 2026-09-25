import { useParams } from 'react-router-dom';
import { Placeholder } from '../components/Placeholder';

/** Deploy in progress (S4), `/deploys/:id/live`. Placeholder until SHP-T-3.4 builds it. */
export function DeployProgress() {
  const { id = '' } = useParams();
  return <Placeholder title={`Deploy ${id}`} task="SHP-T-3.4" />;
}
