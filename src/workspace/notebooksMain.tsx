import { render } from 'preact';
import { LanguageProvider } from '../sidebar/i18n';
import { NotebooksWorkspace } from './NotebooksWorkspace';
import '../sidebar/styles.css';
import './workspace.css';

render(
  <LanguageProvider>
    <NotebooksWorkspace />
  </LanguageProvider>,
  document.getElementById('app')!,
);