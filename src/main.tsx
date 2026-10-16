// (first: it notes every tappable element as the app renders, for controllers)
import './ui/pad/registry';
import { render } from 'preact';
import { App } from './ui/App';
import { OnlineLayer } from './online/OnlineLayer';
import { RematchLayer } from './ui/Rematch';
import { registerServiceWorker } from './ui/pwa';
import { installPad } from './ui/pad/pad';
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
installPad();
