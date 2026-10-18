import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import PopoutWindow from "./chrome/PopoutWindow";
import { parsePopoutWindowKind } from "./chrome/popoutModel";
import "./index.css";

const popoutKind = parsePopoutWindowKind(window.location.search);

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    {popoutKind ? <PopoutWindow kind={popoutKind} /> : <App />}
  </React.StrictMode>,
);
