import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// BizCore standalone — served at root by its own Express server (./server.js).
// No /bizcore prefix anymore (was the team-calendar sub-mount path).
export default defineConfig({
  plugins: [react()],
})
