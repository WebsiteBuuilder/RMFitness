import { render } from 'preact';
import { App } from './ui/App';
import { OnlineLayer } from './online/OnlineLayer';
import './ui/styles.css';
import './ui/polish.css';

render(
  <>
    <App />
    <OnlineLayer />
  </>,
  document.getElementById('app')!,
);
