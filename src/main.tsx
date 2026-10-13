import { render } from 'preact';
import { App } from './ui/App';
import './ui/styles.css';
import './ui/polish.css';

render(<App />, document.getElementById('app')!);
