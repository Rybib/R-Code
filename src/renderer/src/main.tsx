import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles.css'
import { App } from './App'
import { ErrorBoundary } from './components/ErrorBoundary'
import { useStore } from './store'
import * as voice from './voice/voice'

// Handy for debugging from DevTools: __rcode.getState()
;(window as any).__rcode = useStore
;(window as any).__voice = voice

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>
)
