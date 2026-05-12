import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';

if (window.electron) {
  const originalFetch = window.fetch;
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = input.toString();
    if (url.startsWith('/api/') || url.includes('/api/')) {
      try {
        let cleanUrl = url;
        if (url.startsWith('http://') || url.startsWith('https://')) {
          try {
            cleanUrl = new URL(url).pathname;
          } catch (e) {}
        }

        const payload = {
          url: cleanUrl,
          init: init ? {
            method: init.method,
            headers: init.headers,
            body: init.body ? (init.body instanceof FormData ? null : init.body) : null
          } : null
        };
        const result = await window.electron.ipcRenderer.invoke('api-request', payload);
        if (result && result.error) {
          return new Response(JSON.stringify(result), {
            status: 500,
            headers: { 'Content-Type': 'application/json' }
          });
        }
        return new Response(JSON.stringify(result), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      } catch (error: any) {
        return new Response(JSON.stringify({ error: error.message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        });
      }
    }
    return originalFetch(input, init);
  };
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
