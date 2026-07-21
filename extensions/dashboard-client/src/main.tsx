/**
 * dashboard-client/src/main.tsx — React entry point.
 *
 * Mounts <App /> into #root. Loaded by index.html.
 */

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles/base.css";
import "./styles/overview-events.css";
import "./styles/repos-metrics.css";

const rootEl = document.getElementById("root");
if (!rootEl) {
	throw new Error("dashboard-client: #root element not found in index.html");
}

createRoot(rootEl).render(
	<StrictMode>
		<App />
	</StrictMode>,
);
