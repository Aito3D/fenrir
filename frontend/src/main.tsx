import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import { i18nReady } from './i18n'
import App from './App.tsx'

// Every locale loads on demand, English included. Wait for the language in
// use, so the first paint is not raw keys; a slow network paints after 3 s
// and the strings fill in when the file arrives.
const LANGUAGE_WAIT_MS = 3000

Promise.race([i18nReady, new Promise((resolve) => setTimeout(resolve, LANGUAGE_WAIT_MS))])
  .catch(() => {})
  .then(() => {
    createRoot(document.getElementById('root')!).render(
      <StrictMode>
        <App />
      </StrictMode>,
    )
  })
