import orderModel from "../models/orderModel.js";
import userModel from "../models/userModel.js";
import productModel from "../models/productModel.js";

// placing order using COD method
export const placeOrder = async (req, res) => {
  try {
    const userId = req.userId; // ← use middleware value
    const { items, amount, address } = req.body;

    console.log("Received Order Data:", { userId, items, amount, address });

    if (!items || items.length === 0) {
      return res.json({ success: false, message: "No items in the order" });
    }

    const orderData = {
      userId,
      items,
      amount,
      address,
      paymentMethod: "COD",
      payment: false,
      status: "pending",
      date: Date.now(),
    };

    const newOrder = await orderModel.create(orderData);
    console.log("Order created:", newOrder);

    // clear user's cart
    await userModel.findByIdAndUpdate(userId, { cartData: {} });

    res.json({ success: true, message: "Order placed", order: newOrder });
  } catch (error) {
    console.log(error);
    res.json({ success: false, message: error.message });
  }
};

// Esewa payment
export const placeOrderEsewa = async (req, res) => {
  try {
    const userId = req.userId;
    const { items, amount, address, paymentDetails } = req.body;

    if (!items || items.length === 0) {
      return res.json({ success: false, message: "No items in the order" });
    }

    const orderData = {
      userId,
      items,
      amount,
      address,
      paymentMethod: "Esewa",
      payment: true,
      paymentDetails,
      status: "completed",
      date: Date.now(),
    };

    const newOrder = await orderModel.create(orderData);
    await userModel.findByIdAndUpdate(userId, { cartData: {} });

    res.json({ success: true, message: "Order placed via Esewa", order: newOrder });
  } catch (error) {
    console.log(error);
    res.json({ success: false, message: error.message });
  }
};

// all orders for admin panel
export const allOrder = async (req, res) => {
  try {
    const orders = await orderModel.find({});
    res.json({ success: true, orders });
  } catch (error) {
    console.log(error);
    res.json({ success: false, message: error.message });
  }
};

// user orders for frontend
export const userOrders = async (req, res) => {
  try {
    const userId = req.userId; // ← use middleware value
    console.log("Fetching orders for userId:", userId);

    const orders = await orderModel.find({ userId }).sort({ date: -1 });
    console.log("Orders found:", orders);

    if (orders.length === 0) {
      return res.json({
        success: true,
        message: "No orders found",
        orders: [],
      });
    }

    res.json({ success: true, orders });
  } catch (error) {
    console.log(error);
    res.json({ success: false, message: error.message });
  }
};

// update order status from admin panel
export const updateStatus = async (req, res) => {
  try {
    const { orderId, status } = req.body;
    await orderModel.findByIdAndUpdate(orderId, { status });

    res.json({ success: true, message: "Status updated" });
  } catch (error) {
    console.log(error);
    res.json({ success: false, message: error.message });
  }
};

// delete completed/delivered order from admin panel
export const deleteOrder = async (req, res) => {
  try {
    const { id } = req.params;

    const order = await orderModel.findById(id);

    if (!order) {
      return res.status(404).json({
        success: false,
        message: "Order not found",
      });
    }

    // Only allow deletion for completed/delivered orders
    if (order.status !== "Delivered" && order.status !== "completed") {
      return res.status(400).json({
        success: false,
        message: "Only delivered/completed orders can be deleted",
      });
    }

    await orderModel.findByIdAndDelete(id);

    res.json({
      success: true,
      message: "Order deleted successfully",
    });
  } catch (error) {
    console.log(error);
    res.status(500).json({ success: false, message: error.message });
  }
};

// Khalti ePayment (KPG-2)
// https://docs.khalti.com/khalti-epayment/
// Sandbox: POST https://dev.khalti.com/api/v2/epayment/initiate/
// Lookup:  POST https://dev.khalti.com/api/v2/epayment/lookup/
const getKhaltiBaseUrl = () =>
  (process.env.KHALTI_API_URL || "https://dev.khalti.com/api/v2").replace(
    /\/$/,
    ""
  );

/** Docs: amount is in paisa. Rs 10 = 1000 paisa, and that is the minimum. */
const nprToPaisa = (npr) => Math.round(Number(npr) * 100);
const DELIVERY_FEE_PAISA = 10000;

const khaltiErrorMessage = (data, status) => {
  if (!data || typeof data !== "object") {
    return `Khalti error (${status})`;
  }
  if (typeof data.detail === "string") return data.detail;
  const fieldErrors = Object.entries(data)
    .filter(([key]) => key !== "error_key" && key !== "status_code")
    .map(([key, value]) => {
      const text = Array.isArray(value) ? value.join(", ") : String(value);
      return `${key}: ${text}`;
    });
  return fieldErrors[0] || data.error_key || `Khalti error (${status})`;
};

const khaltiRequest = async (path, body) => {
  const secret = String(process.env.KHALTI_SECRET_KEY || "").trim();
  if (!secret) {
    return {
      ok: false,
      status: 500,
      data: {
        detail:
          "Add KHALTI_SECRET_KEY to Backend/.env from https://test-admin.khalti.com (sandbox live secret key), then restart the backend.",
      },
    };
  }

  const url = `${getKhaltiBaseUrl()}${path}`;
  // Official curl samples use "key <secret>". Some dashboard text says "Key".
  const send = (prefix) =>
    fetch(url, {
      method: "POST",
      headers: {
        Authorization: `${prefix} ${secret}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

  let response = await send("key");
  if (response.status === 401) {
    response = await send("Key");
  }

  const raw = await response.text();
  let data = {};
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch {
    data = { detail: raw.slice(0, 200) || "Invalid response from Khalti" };
  }

  return { ok: response.ok, status: response.status, data };
};

export const initiateKhaltiPayment = async (req, res) => {
  try {
    const userId = req.userId;
    const { items, address } = req.body;

    if (
      !Array.isArray(items) ||
      items.length === 0 ||
      items.some(
        (item) =>
          !item ||
          !/^[a-f\d]{24}$/i.test(String(item._id)) ||
          !Number.isSafeInteger(Number(item.quantity)) ||
          Number(item.quantity) < 1
      )
    ) {
      return res.status(400).json({
        success: false,
        message: "Order must contain valid product IDs and quantities.",
      });
    }

    const productIds = items.map((item) => String(item._id));
    if (new Set(productIds).size !== productIds.length) {
      return res.status(400).json({
        success: false,
        message: "Order contains duplicate products.",
      });
    }

    const products = await productModel
      .find({ _id: { $in: productIds } })
      .select("name price image")
      .lean();
    if (products.length !== productIds.length) {
      return res.status(400).json({
        success: false,
        message: "One or more products are no longer available.",
      });
    }

    const productsById = new Map(
      products.map((product) => [String(product._id), product])
    );
    const orderItems = items.map((item) => {
      const product = productsById.get(String(item._id));
      return {
        _id: String(product._id),
        name: product.name,
        price: product.price,
        image: product.image,
        quantity: Number(item.quantity),
      };
    });

    const itemsAmountPaisa = orderItems.reduce(
      (total, item) => total + nprToPaisa(item.price) * item.quantity,
      0
    );
    const amountPaisa = itemsAmountPaisa + DELIVERY_FEE_PAISA;
    if (!Number.isSafeInteger(amountPaisa) || amountPaisa < 1000) {
      return res.status(400).json({
        success: false,
        message: "The order amount is invalid.",
      });
    }

    const frontendUrl = (
      process.env.FRONTEND_URL || "http://localhost:5173"
    ).replace(/\/$/, "");

    const phoneDigits = String(address?.phone || "").replace(/\D/g, "");
    const phone =
      phoneDigits.length >= 10 ? phoneDigits.slice(-10) : "9800000001";

    const order = await orderModel.create({
      userId,
      items: orderItems,
      amount: amountPaisa / 100,
      address,
      paymentMethod: "Khalti",
      payment: false,
      status: "Khalti Pending",
      date: Date.now(),
    });

    const purchaseOrderId = order._id.toString();
    const payload = {
      return_url: `${frontendUrl}/payment/khalti-return`,
      website_url: frontendUrl,
      amount: amountPaisa,
      purchase_order_id: purchaseOrderId,
      purchase_order_name:
        orderItems.length === 1
          ? String(orderItems[0].name || "Order").slice(0, 120)
          : `Order (${orderItems.length} items)`,
      customer_info: {
        name: `${address?.firstName || ""} ${address?.lastName || ""}`.trim(),
        email: address?.email,
        phone,
      },
      amount_breakdown: [
        { label: "Items", amount: itemsAmountPaisa },
        { label: "Delivery", amount: DELIVERY_FEE_PAISA },
      ],
      product_details: orderItems.map((item) => {
        const unitPrice = nprToPaisa(item.price);
        const quantity = item.quantity;
        return {
          identity: String(item._id || item.name || "item"),
          name: String(item.name || "Product").slice(0, 100),
          unit_price: unitPrice,
          quantity,
          total_price: unitPrice * quantity,
        };
      }),
    };

    const { ok, status, data } = await khaltiRequest(
      "/epayment/initiate/",
      payload
    );

    if (!ok || !data.payment_url || !data.pidx) {
      await orderModel.findByIdAndDelete(order._id);
      return res.json({
        success: false,
        message: khaltiErrorMessage(data, status),
      });
    }

    await orderModel.findByIdAndUpdate(order._id, {
      khaltiPidx: data.pidx,
    });

    return res.json({
      success: true,
      payment_url: data.payment_url,
      pidx: data.pidx,
      orderId: purchaseOrderId,
    });
  } catch (error) {
    console.log(error);
    res.json({ success: false, message: error.message });
  }
};

export const verifyKhaltiPayment = async (req, res) => {
  try {
    const userId = String(req.userId);
    const { pidx, orderId } = req.body;

    if (!pidx || !orderId) {
      return res.json({
        success: false,
        message: "pidx and orderId are required",
      });
    }

    const order = await orderModel.findById(orderId);
    if (!order || String(order.userId) !== userId) {
      return res.status(404).json({ success: false, message: "Order not found" });
    }

    if (String(order.khaltiPidx) !== String(pidx)) {
      return res.status(400).json({
        success: false,
        message: "Payment ID does not match this order.",
      });
    }

    if (order.payment) {
      return res.json({
        success: true,
        message: "Order already confirmed",
        order,
      });
    }

    // Docs: never trust the redirect alone. Confirm with /epayment/lookup/.
    const { ok, status, data: lookup } = await khaltiRequest(
      "/epayment/lookup/",
      { pidx }
    );

    if (!ok || lookup.pidx !== pidx || lookup.status !== "Completed") {
      await orderModel.findByIdAndUpdate(orderId, {
        status:
          lookup.status === "Completed"
            ? "Khalti Pending"
            : lookup.status || "Khalti Pending",
        payment: false,
        paymentDetails: { pidx, lookup },
      });
      return res.json({
        success: false,
        message: lookup.status || khaltiErrorMessage(lookup, status),
      });
    }

    const expectedPaisa = nprToPaisa(order.amount);
    if (Number(lookup.total_amount) !== expectedPaisa) {
      return res.json({
        success: false,
        message: "Amount mismatch with order",
        lookup,
      });
    }

    await orderModel.findByIdAndUpdate(orderId, {
      payment: true,
      status: "OrderPlaced",
      paymentDetails: {
        pidx,
        transaction_id: lookup.transaction_id,
        fee: lookup.fee,
        lookup,
      },
    });

    await userModel.findByIdAndUpdate(userId, { cartData: {} });

    const updated = await orderModel.findById(orderId);
    return res.json({
      success: true,
      message: "Payment verified",
      order: updated,
    });
  } catch (error) {
    console.log(error);
    res.json({ success: false, message: error.message });
  }
};