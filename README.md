# BizCore

Internal back-office app for finance, payroll, and insurance — pulls from QuickBooks, Gusto, and Corebridge.

## Stack

Vite + React (vanilla JS).

## Layout

```
src/
  App.jsx                  app shell + page routing
  styles/globals.css       theme + layout
  components/Sidebar.jsx   left nav
  pages/                   one component per route
  adapters/                external-API clients (QuickBooks, Gusto, Corebridge)
```

## Run

```
npm install
npm run dev
```
