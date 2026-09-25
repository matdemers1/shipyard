import { useParams } from 'react-router-dom';
import { Placeholder } from '../components/Placeholder';

/** Restore (S7), `/apps/:app/restore`. Placeholder until a later phase builds it. */
export function Restore() {
  const { app = '' } = useParams();
  return <Placeholder title={`Restore ${app}`} task="a later phase" />;
}
