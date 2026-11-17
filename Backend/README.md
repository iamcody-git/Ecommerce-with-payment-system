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
