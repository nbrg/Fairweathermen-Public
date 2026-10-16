import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";

// Add font awesome for icons
const linkElement = document.createElement("link");
linkElement.rel = "stylesheet";
linkElement.href = "https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0-beta3/css/all.min.css";
document.head.appendChild(linkElement);

// Add fonts
const fontLink = document.createElement("link");
fontLink.rel = "stylesheet";
fontLink.href = "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap";
document.head.appendChild(fontLink);

// Add title
const titleElement = document.createElement("title");
titleElement.textContent = "Premier League Prediction League";
document.head.appendChild(titleElement);

// Don't let the browser restore a previous scroll position on reload — we
// always want the navbar visible at the top (see App.tsx). Otherwise a mobile
// reload can land part-way down the page and hide the game nav.
if ("scrollRestoration" in history) {
  history.scrollRestoration = "manual";
}

createRoot(document.getElementById("root")!).render(<App />);

// Register the PWA service worker (needed for install + push reminders).
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch((err) => {
      console.error("Service worker registration failed:", err);
    });
  });
}
