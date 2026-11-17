# Khalti ePayment (sandbox)

The storefront uses Khalti's KPG-2 Web Checkout. The secret key is used only by
the backend; never put it in a `VITE_` variable or frontend source.

## Configure sandbox access

1. Create a test merchant account at <https://test-admin.khalti.com/#/join/merchant>.
2. Copy the sandbox `live_secret_key` from the merchant dashboard into
   `Backend/.env` as `KHALTI_SECRET_KEY`. Do not use a production key.
3. Set `KHALTI_API_URL=https://dev.khalti.com/api/v2` and
   `FRONTEND_URL=http://localhost:5173` in `Backend/.env`.
4. Start MongoDB and the backend (`cd Backend; npm run dev`), then start the
   storefront (`cd Frontend; npm run dev`).
5. Sign in, add products to the cart, and select Khalti at checkout. The
   server calculates product prices and the Rs. 100 delivery fee; Khalti
   requires the payment amount to be at least 1000 paisa.
6. On Khalti's sandbox checkout, use a test ID from the official docs
   (`9800000000`–`9800000005`), MPIN `1111`, and OTP `987654`. Sandbox
   transactions are test transactions and do not charge real money.

Khalti redirects the customer back to the storefront, which asks the backend
to verify the `pidx` with Khalti's lookup API before marking the order paid.
Only a `Completed` lookup with the matching order and amount is accepted.

To switch to production, use the production secret key from
<https://admin.khalti.com> and set
`KHALTI_API_URL=https://khalti.com/api/v2`. Configure `FRONTEND_URL` to the
public storefront URL and ensure the backend and return URL are reachable.

References:

- [Khalti ePayment Web Checkout docs](https://docs.khalti.com/khalti-epayment/)
- [Smile Pant's Node.js/MongoDB guide](https://blog.smilepant.com/integrating-khalti-payment-gateway-with-node-js-and-mongodb/)

# eSewa ePay V2 (sandbox)

The storefront starts eSewa checkout with a server-generated signature. The
backend verifies eSewa's signed return and checks the transaction status with
eSewa before marking an order as paid. Keep the eSewa secret key on the backend;
never expose it in a `VITE_` variable or frontend source.

1. Configure your eSewa merchant account for ePay V2. For sandbox testing, set
   `ESEWA_PRODUCT_CODE=EPAYTEST`, `ESEWA_GATEWAY_URL=https://rc-epay.esewa.com.np`,
   and the sandbox secret key as `ESEWA_SECRET_KEY` in `Backend/.env`.
2. Set `FRONTEND_URL=http://localhost:5173`; the backend uses it for the eSewa
   success and failure return URLs.
3. Start MongoDB, the backend (`cd Backend; npm run dev`), and the storefront
   (`cd Frontend; npm run dev`).
4. Sign in, add products to the cart, and select eSewa at checkout. The backend
   calculates the current product prices and Rs. 100 delivery fee. A completed
   eSewa transaction is confirmed with the transaction status API before the
   order is marked paid.

For production, use the product code and secret assigned to your merchant
account and configure `ESEWA_GATEWAY_URL` with the production ePay V2 gateway.
Set `FRONTEND_URL` to the public storefront URL and ensure the backend and
return URL are reachable.

References:

- [eSewa ePay documentation](https://developer.esewa.com.np/)
- [Smile Pant's Node.js/MongoDB guide](https://blog.smilepant.com/integrating-esewa-payment-gateway-with-node-js/)
