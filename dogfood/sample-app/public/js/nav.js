// Shared navigation bar, injected into every page (see docs/spec.md section 4).
(function () {
  const items = [
    { label: "Home", href: "/" },
    { label: "Features", href: "/features.html" },
    { label: "Pricing", href: "/pricing.html" },
    { label: "About", href: "#" },
  ];
  const nav = document.createElement("nav");
  nav.setAttribute("aria-label", "Primary");
  for (const item of items) {
    const a = document.createElement("a");
    a.href = item.href;
    a.textContent = item.label;
    nav.appendChild(a);
  }
  document.body.prepend(nav);
})();
