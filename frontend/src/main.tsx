import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, HashRouter } from "react-router-dom";
import { MODE } from "./api";
import App from "./App";
import { registerServiceWorker } from "./pwa";
import "./styles.css";

// The browser build is installable and works offline (the server build has no service worker).
if (MODE === "browser" && import.meta.env.PROD) registerServiceWorker();

// The browser build is a static site: hash URLs work on any host without rewrite rules.
const Router = MODE === "browser" ? HashRouter : BrowserRouter;

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Router>
      <App />
    </Router>
  </React.StrictMode>,
);
