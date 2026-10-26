// Checkout handler (see docs/spec.md section 5).
(function () {
  const btn = document.getElementById("order-btn");
  const status = document.getElementById("checkout-status");
  if (!btn || !status) return;
  btn.addEventListener("click", function (e) {
    e.preventDefault();
    status.textContent = "Order received";
  });
})();
