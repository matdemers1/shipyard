import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

// The console lands in Phase 4; @d3cloud/ui arrives with it.
const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <StrictMode>
      <main>Shipyard</main>
    </StrictMode>,
  );
}
