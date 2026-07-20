import React from "react";
import ReactDOM from "react-dom/client";
import { getCurrentWindow } from "@tauri-apps/api/window";
import App from "./App";
import { RealmQApp } from "./realmq/RealmQApp";
import { AppProvider, ThemeProvider } from "./contexts";
import "./global.css";

// Branch on the Tauri window label so the second WebviewWindow (labelled
// "realmq", opened by open_realmq_window) renders the cockpit instead of the
// main app — same JS bundle, different roots.
const label = getCurrentWindow().label;

const root = ReactDOM.createRoot(document.getElementById("root") as HTMLElement);

if (label === "realmq") {
  root.render(
    <React.StrictMode>
      <ThemeProvider>
        <RealmQApp />
      </ThemeProvider>
    </React.StrictMode>
  );
} else {
  root.render(
    <React.StrictMode>
      <ThemeProvider>
        <AppProvider>
          <App />
        </AppProvider>
      </ThemeProvider>
    </React.StrictMode>
  );
}
