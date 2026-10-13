import { render } from 'preact';
import { App } from './ui/App';
import { registerServiceWorker } from './ui/pwa';
import './ui/styles.css';
import './ui/polish.css';
import './ui/speedui.css';
import './ui/layout.css';

render(<App />, document.getElementById('app')!);
registerServiceWorker();
