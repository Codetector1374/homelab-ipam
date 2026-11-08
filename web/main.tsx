import React from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createTheme, CssBaseline, ThemeProvider } from '@mui/material';
import App from './App';
import type { Session } from '../shared/types';
import './style.css';

const client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: true } } });
window.addEventListener('ipam:unauthorized', () => {
  client.setQueryData<Session>(['session'], previous => ({ authenticated: false, mode: previous?.mode ?? 'oidc', user: null }));
  client.removeQueries({ queryKey: ['state'] });
});
const theme = createTheme({
  palette: { mode: 'light', primary: { main: '#087f75', dark: '#05665e' }, secondary: { main: '#344862' }, background: { default: '#f5f7fa', paper: '#ffffff' }, text: { primary: '#1c2c40', secondary: '#66768a' } },
  typography: { fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif', h4: { fontWeight: 750, letterSpacing: '-0.035em' }, h5: { fontWeight: 700 }, h6: { fontWeight: 700 }, button: { textTransform: 'none', fontWeight: 650 } },
  shape: { borderRadius: 12 },
  components: {
    MuiButton: { defaultProps: { disableElevation: true } },
    MuiPaper: { styleOverrides: { root: { backgroundImage: 'none' } } },
    MuiTextField: { defaultProps: { size: 'small', fullWidth: true } },
    MuiDialog: { defaultProps: { fullWidth: true, maxWidth: 'sm' } },
    MuiCard: { defaultProps: { variant: 'outlined' }, styleOverrides: { root: { borderColor: '#e1e7ed' } } },
    MuiChip: { defaultProps: { size: 'small' } },
  },
});

createRoot(document.getElementById('root')!).render(<React.StrictMode><QueryClientProvider client={client}><ThemeProvider theme={theme}><CssBaseline /><App /></ThemeProvider></QueryClientProvider></React.StrictMode>);
