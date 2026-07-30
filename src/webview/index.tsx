import { createRoot } from 'react-dom/client';
import '@xyflow/react/dist/style.css';
import { App } from './App';
import './styles.css';

const rootEl = document.getElementById('root');
if (rootEl) {
  createRoot(rootEl).render(<App />);
}
