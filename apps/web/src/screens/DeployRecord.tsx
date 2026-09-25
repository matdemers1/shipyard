import { useParams } from 'react-router-dom';
import { Placeholder } from '../components/Placeholder';

/** Deploy record (S6), `/deploys/:id`. Placeholder until SHP-T-3.7 builds it. */
export function DeployRecord() {
  const { id = '' } = useParams();
  return <Placeholder title={`Deploy ${id}`} task="SHP-T-3.7" />;
}
