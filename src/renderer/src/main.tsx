import './assets/main.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ThemeProvider } from 'next-themes'
import { TooltipProvider } from '@/components/ui/tooltip'
import { Toaster } from '@/components/ui/sonner'
import App from './App'

// macOS draws real window vibrancy behind the shell (src/main/index.ts); the CSS
// layers in main.css only go translucent where this flag says it is there.
if (navigator.platform.startsWith('Mac')) document.documentElement.dataset.glass = 'native'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider
      attribute="class"
      defaultTheme="system"
      storageKey="plumbr-theme"
      disableTransitionOnChange
    >
      <TooltipProvider>
        <App />
        <Toaster position="bottom-right" />
      </TooltipProvider>
    </ThemeProvider>
  </StrictMode>
)
