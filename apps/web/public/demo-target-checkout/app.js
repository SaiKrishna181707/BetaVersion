const app = document.getElementById('app');
const cartBadge = document.getElementById('cart-counter');

let cart = 0;
let route = window.location.hash.replace(/^#/, '') || '/';

function navigate(newRoute) {
  route = newRoute;
  window.location.hash = newRoute;
  render();
}

window.addEventListener('hashchange', () => {
  route = window.location.hash.replace(/^#/, '') || '/';
  render();
});

function render() {
  cartBadge.textContent = `Cart (${cart})`;

  if (route === '/' || route === '') {
    app.innerHTML = `
      <div class="product-card">
        <div class="product-img">📦</div>
        <div class="product-info">
          <h2>Developer Pro Subscription (Annual)</h2>
          <p>Full suite cloud development credentials and continuous testing workflows.</p>
          <div class="product-price">$49.00 / year</div>
          <button id="add-to-cart-btn" class="btn btn-primary" onclick="window.addToCart()">Add to Cart</button>
        </div>
      </div>
    `;
  } else if (route === '/cart') {
    app.innerHTML = `
      <h2>Your Shopping Cart</h2>
      <p style="margin-bottom: 20px;">Review your items before checkout.</p>
      <div style="display: flex; justify-content: space-between; padding: 16px 0; border-bottom: 1px solid #eee;">
        <span>Developer Pro Subscription (Annual) x 1</span>
        <strong>$49.00</strong>
      </div>
      <div style="display: flex; justify-content: flex-end; margin-top: 24px;">
        <button id="proceed-checkout-btn" class="btn btn-primary" onclick="window.goCheckout()">Proceed to Checkout</button>
      </div>
    `;
  } else if (route === '/checkout') {
    app.innerHTML = `
      <div style="background: #fef9c3; border: 1px solid #facc15; padding: 10px 14px; border-radius: 6px; margin-bottom: 20px; font-size: 13px; color: #854d0e; font-weight: 700; text-align: center;">
        ⚠️ SIMULATED CHECKOUT — NO REAL PAYMENT
      </div>
      <h2>Complete Checkout</h2>
      <p style="margin-bottom: 20px;">Enter billing email and shipping info.</p>
      <div class="form-group">
        <label for="email">Billing Email</label>
        <input id="email" type="email" placeholder="you@company.com" required value="developer@synthetic-beta.local" />
      </div>
      <div class="form-group">
        <label for="zip">Postal / Zip Code</label>
        <input id="zip" type="text" placeholder="10001" required value="10001" />
        <div id="zip-error" class="form-error" style="display: none;">Invalid zip code.</div>
      </div>
      <div class="accordion" id="promo-accordion">
        <div class="accordion-header" onclick="document.getElementById('promo-accordion').classList.toggle('open')">
          Have a promotional code? (Click to expand)
        </div>
        <div class="accordion-content">
          <input type="text" placeholder="BETA2026" style="width: 70%; padding: 8px;" />
          <button class="btn" style="padding: 8px 16px;" onclick="alert('Promo code applied!')">Apply</button>
        </div>
      </div>
      <div style="margin-top: 24px;">
        <button id="place-order-btn" class="btn btn-primary" style="width: 100%;" onclick="window.placeOrder()">Complete Simulated Order ($49.00 - Test Mode)</button>
      </div>
    `;
  } else if (route === '/confirmed') {
    app.innerHTML = `
      <div class="success-banner">
        <div class="success-icon">✓</div>
        <h2>Order Confirmed!</h2>
        <p>Order #SB-98421 has been placed successfully.</p>
        <p style="color: #666; margin-top: 8px;">SIMULATED CHECKOUT — NO REAL PAYMENT. Test mode completed.</p>
      </div>
    `;
  }
}

window.addToCart = () => {
  cart = 1;
  navigate('/cart');
};

window.goCheckout = () => {
  navigate('/checkout');
};

window.placeOrder = () => {
  const btn = document.getElementById('place-order-btn');
  if (btn) {
    btn.textContent = 'Processing Order...';
    btn.disabled = true;
  }
  setTimeout(() => {
    navigate('/confirmed');
  }, 600);
};

render();
