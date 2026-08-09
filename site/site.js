// Stamped at build time so a published deploy is visibly distinct from a local one.
document.getElementById("stamp").textContent =
  document.documentElement.dataset.build ?? "local";
