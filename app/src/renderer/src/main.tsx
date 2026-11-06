import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource-variable/inter'
import '@fontsource/jetbrains-mono/400.css'
import '@xterm/xterm/css/xterm.css'
import 'uplot/dist/uPlot.min.css'
import './styles/index.css'
import { App } from './app/App'
import { DesignPage } from './design/DesignPage'

// #/design keeps the design-system gallery reachable for replica-diff and QA.
const root = createRoot(document.getElementById('root')!)
const render = () =>
  root.render(<StrictMode>{window.location.hash.startsWith('#/design') ? <DesignPage /> : <App />}</StrictMode>)
render()
window.addEventListener('hashchange', (e) => {
  const wasDesign = new URL(e.oldURL).hash.startsWith('#/design')
  if (wasDesign !== window.location.hash.startsWith('#/design')) render()
})
