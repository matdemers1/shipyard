import { useParams } from 'react-router-dom';
import { Placeholder } from '../components/Placeholder';

/** App detail (S5), `/apps/:app`. Placeholder until SHP-T-3.5 builds it. */
export function AppDetail() {
  const { app = '' } = useParams();
  return <Placeholder title={app} task="SHP-T-3.5" />;
}
