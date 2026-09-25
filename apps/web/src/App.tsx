import { ThemeProvider, TooltipProvider } from '@d3cloud/ui';
import { BrowserRouter } from 'react-router-dom';
import { AuthProvider } from './lib/auth';
import { AppRoutes } from './routes';

export const THEME_STORAGE_KEY = 'shipyard.theme';

/** Light and dark follow the system until the person picks one (SHP-REQ-055). */
export function App() {
  return (
    <ThemeProvider storageKey={THEME_STORAGE_KEY} defaultPreference="system">
      <TooltipProvider>
        <BrowserRouter>
          <AuthProvider>
            <AppRoutes />
          </AuthProvider>
        </BrowserRouter>
      </TooltipProvider>
    </ThemeProvider>
  );
}
