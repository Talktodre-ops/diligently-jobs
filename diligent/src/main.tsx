import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { AppProvider, ThemeProvider } from "./contexts";
import "./global.css";

const root = ReactDOM.createRoot(document.getElementById("root") as HTMLElement);

root.render(
  <React.StrictMode>
    <ThemeProvider>
      <AppProvider>
        <App />
      </AppProvider>
    </ThemeProvider>
  </React.StrictMode>
);
