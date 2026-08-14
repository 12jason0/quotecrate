(function () {
  "use strict";

  function setMessage(element, text, state) {
    element.textContent = text;
    element.dataset.state = state;
    element.hidden = false;
  }

  /**
   * Read every product row into the items array the endpoint expects.
   *
   * A row only counts when its quantity parses to a positive integer, so blank
   * and 0 rows are dropped here rather than being sent and rejected. Product
   * identity comes from the row's data-* attributes, never from anything the
   * shopper can type.
   */
  function collectItems(form) {
    var rows = form.querySelectorAll("[data-quotecrate-item]");
    var items = [];

    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      var input = row.querySelector('input[name="quantity"]');
      var raw = input ? String(input.value).trim() : "";
      if (raw === "") continue;

      var quantity = parseInt(raw, 10);
      if (!isFinite(quantity) || quantity < 1) continue;

      items.push({
        title: row.getAttribute("data-product-title") || "",
        quantity: quantity,
        productId: row.getAttribute("data-product-id") || "",
        variantId: row.getAttribute("data-variant-id") || "",
        variantTitle: row.getAttribute("data-variant-title") || "",
      });
    }

    return items;
  }

  function bind(form) {
    if (form.dataset.quotecrateBound === "true") return;
    form.dataset.quotecrateBound = "true";

    var message = form.querySelector("[data-quotecrate-message]");
    var submit = form.querySelector('button[type="submit"]');

    form.addEventListener("submit", function (event) {
      event.preventDefault();

      if (submit.disabled) return;

      var data = new FormData(form);
      var items = collectItems(form);

      // Caught here so the shopper gets an immediate answer instead of a round
      // trip; the endpoint enforces the same rule regardless.
      if (items.length === 0) {
        setMessage(
          message,
          "Enter a quantity for at least one product.",
          "error"
        );
        return;
      }

      var payload = {
        customerName: (data.get("customerName") || "").trim(),
        customerEmail: (data.get("customerEmail") || "").trim(),
        company: (data.get("company") || "").trim(),
        note: (data.get("note") || "").trim(),
        items: items,
      };

      submit.disabled = true;
      var originalLabel = submit.textContent;
      submit.textContent = "Sending…";
      message.hidden = true;

      fetch(form.dataset.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(payload),
      })
        .then(function (response) {
          // A non-JSON body here usually means the proxy path is wrong and the
          // storefront returned its own 404 page, so report that plainly.
          return response
            .json()
            .catch(function () {
              throw new Error(
                "Unexpected response from the server (" + response.status + ")."
              );
            })
            .then(function (body) {
              if (!response.ok || !body.ok) {
                throw new Error(body.error || "Could not send your request.");
              }
              return body;
            });
        })
        .then(function () {
          form.reset();
          setMessage(
            message,
            "Thanks — your quote request has been sent. We'll be in touch by email.",
            "success"
          );
        })
        .catch(function (error) {
          setMessage(message, error.message, "error");
        })
        .finally(function () {
          submit.disabled = false;
          submit.textContent = originalLabel;
        });
    });
  }

  function init() {
    document.querySelectorAll("[data-quotecrate-form]").forEach(bind);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  // The theme editor re-renders sections without a full page load.
  document.addEventListener("shopify:section:load", init);
})();
