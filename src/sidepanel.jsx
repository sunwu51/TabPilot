/* global chrome */
import App from './App';
import { createRoot } from 'react-dom/client';
import { installWarnFilter } from './warnFilter';
import './index.css'

installWarnFilter();

chrome.runtime.onMessage.addListener(function (e) {
    console.log(e);
    return false;
});

const root = createRoot(document.getElementById('root'));
root.render(
    <App />
);
