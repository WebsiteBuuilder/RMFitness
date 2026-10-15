import { render } from 'preact';
import { App } from './ui/App';
import { OnlineLayer } from './online/OnlineLayer';
import { RematchLayer } from './ui/Rematch';
import { registerServiceWorker } from './ui/pwa';
import './ui/styles.css';
import './ui/polish.css';
import './ui/speedui.css';
import './ui/layout.css';

render(
  <>
    <App />
    <OnlineLayer />
    <RematchLayer />
  </>,
  document.getElementById('app')!,
);
registerServiceWorker();
