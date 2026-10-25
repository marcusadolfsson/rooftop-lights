import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { LightSocketProvider } from './hooks/useLightSocket';
import './index.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <BrowserRouter>
    <LightSocketProvider>
      <App />
    </LightSocketProvider>
  </BrowserRouter>
);
